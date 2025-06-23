const logger = require("../../utils/logger");
const metricsService = require("../../services/metrics");
const redisService = require("../../services/redis");

// Almacenamiento en memoria (se reemplazará gradualmente por Redis)
const workspaceSockets = {}; // workspaceId -> Map(socketId -> userData)
const userLastSeen = new Map(); // workspaceId -> Map<userId -> timestamp>
const pendingDisconnections = new Map(); // socketId -> { userData, workspaceId, timeout }

/**
 * Clase para manejar eventos relacionados con workspaces
 */
class WorkspaceHandler {
  /**
   * Inicializa el handler con la instancia de socket.io
   * @param {Object} io - Instancia de Socket.IO
   */
  constructor(io) {
    this.io = io;
    this.REDIS_PREFIX = "workspace:";

    // Limpiar datos duplicados cada 30 segundos
    setInterval(() => {
      this.cleanupDuplicateUsers();
    }, 30000);
  }

  /**
   * Registra todos los manejadores de eventos para workspaces
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on("join_workspace", (workspaceId, userData) =>
      this.handleJoinWorkspace(socket, workspaceId, userData)
    );
    socket.on("leave_workspace", (workspaceId) =>
      this.handleLeaveWorkspace(socket, workspaceId)
    );
    socket.on("get_workspace_users", (workspaceId) =>
      this.handleGetWorkspaceUsers(socket, workspaceId)
    );
  }

  /**
   * Maneja el evento de unirse a un workspace
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {Object} userData - Datos del usuario
   */
  async handleJoinWorkspace(socket, workspaceId, userData) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          userId: userData.id,
          email: userData.email,
          workspaceId,
          isReconnection: userData.isReconnection,
        },
        "Usuario uniéndose al workspace"
      );

      // Obtener usuarios actuales antes de añadir el nuevo
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const currentWorkspaceUsers = (await redisService.get(redisKey)) || {};

      // Verificar si el usuario ya está conectado con otro socket
      const existingUserSocket = Object.entries(currentWorkspaceUsers).find(
        ([socketId, user]) =>
          user.email === userData.email && socketId !== socket.id
      );

      // Cancelar cualquier desconexión pendiente para este usuario
      const pendingDisconnection = Array.from(
        pendingDisconnections.entries()
      ).find(
        ([socketId, data]) =>
          data.userData.email === userData.email &&
          data.workspaceId === workspaceId
      );

      if (pendingDisconnection) {
        const [pendingSocketId, pendingData] = pendingDisconnection;
        clearTimeout(pendingData.timeout);
        pendingDisconnections.delete(pendingSocketId);
        logger.info(
          {
            cancelledSocketId: pendingSocketId,
            newSocketId: socket.id,
            userEmail: userData.email,
            workspaceId,
          },
          "Cancelada desconexión pendiente - usuario reconectado"
        );
      }

      // Si el usuario ya está conectado, eliminar la conexión antigua
      if (existingUserSocket) {
        const [oldSocketId, oldUserData] = existingUserSocket;
        delete currentWorkspaceUsers[oldSocketId];

        // También eliminar de memoria local
        if (workspaceSockets[workspaceId]) {
          workspaceSockets[workspaceId].delete(oldSocketId);
        }

        logger.info(
          {
            oldSocketId,
            newSocketId: socket.id,
            userEmail: userData.email,
            workspaceId,
          },
          "Reemplazando conexión antigua del usuario"
        );
      }

      // Limpiar cualquier otra conexión del mismo usuario en memoria local
      if (!workspaceSockets[workspaceId]) {
        workspaceSockets[workspaceId] = new Map();
      } else {
        // Buscar y eliminar otras conexiones del mismo usuario
        for (const [socketId, existingUser] of workspaceSockets[workspaceId]) {
          if (existingUser.email === userData.email && socketId !== socket.id) {
            workspaceSockets[workspaceId].delete(socketId);
            logger.info(
              {
                removedSocketId: socketId,
                userEmail: userData.email,
                workspaceId,
              },
              "Eliminada conexión duplicada de memoria local"
            );
          }
        }
      }

      workspaceSockets[workspaceId].set(socket.id, userData);

      // Guardar en Redis para escalabilidad horizontal
      currentWorkspaceUsers[socket.id] = userData;
      await redisService.set(redisKey, currentWorkspaceUsers);

      // Actualizar última vez visto
      if (!userLastSeen.has(workspaceId)) {
        userLastSeen.set(workspaceId, new Map());
      }
      userLastSeen.get(workspaceId).set(userData.email, new Date());

      // Unir al socket a la sala del workspace
      socket.join(workspaceId);

      // Obtener usuarios conectados y eliminar duplicados por email
      const allUsers = Object.values(currentWorkspaceUsers);
      const connectedUsers = this.removeDuplicateUsers(allUsers);

      // Notificar a todos los usuarios del workspace
      this.io.to(workspaceId).emit("users_connected", connectedUsers);

      // Solo emitir user_joined si no es una reconexión o si es la primera vez que se conecta
      const shouldNotifyJoin = !userData.isReconnection || !existingUserSocket;
      if (shouldNotifyJoin) {
        this.io.to(workspaceId).emit("user_joined", userData);
      }

      // Registrar métricas
      metricsService.userJoinedWorkspace(workspaceId, userData.id);
      metricsService.messageProcessed("join_workspace", Date.now() - startTime);

      logger.info(
        {
          socketId: socket.id,
          userId: userData.id,
          workspaceId,
          userCount: connectedUsers.length,
          notificationSent: shouldNotifyJoin,
        },
        "Usuario unido al workspace correctamente"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al unirse al workspace"
      );

      metricsService.errorOccurred("join_workspace", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al unirse al workspace",
        details: error.message,
      });
    }
  }

  /**
   * Maneja el evento de salir de un workspace
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async handleLeaveWorkspace(socket, workspaceId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
        },
        "Usuario saliendo del workspace"
      );

      // Cancelar cualquier desconexión pendiente para este socket
      if (pendingDisconnections.has(socket.id)) {
        const pendingData = pendingDisconnections.get(socket.id);
        clearTimeout(pendingData.timeout);
        pendingDisconnections.delete(socket.id);
        logger.info(
          {
            socketId: socket.id,
            workspaceId,
          },
          "Cancelada desconexión pendiente - salida explícita"
        );
      }

      // Obtener datos del usuario de la memoria local
      let userData = null;
      if (workspaceSockets[workspaceId]) {
        userData = workspaceSockets[workspaceId].get(socket.id);
        workspaceSockets[workspaceId].delete(socket.id);
      }

      // Actualizar en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const workspaceUsers = (await redisService.get(redisKey)) || {};

      if (workspaceUsers[socket.id]) {
        userData = userData || workspaceUsers[socket.id];
        delete workspaceUsers[socket.id];
        await redisService.set(redisKey, workspaceUsers);
      }

      // Actualizar última vez visto
      if (userData && userLastSeen.has(workspaceId)) {
        userLastSeen.get(workspaceId).set(userData.email, new Date());
      }

      // Salir de la sala
      socket.leave(workspaceId);

      // Notificar a los demás usuarios
      if (userData) {
        this.io.to(workspaceId).emit("user_left", userData);

        // Actualizar lista de usuarios conectados
        const allUsers = Object.values(workspaceUsers);
        const connectedUsers = this.removeDuplicateUsers(allUsers);
        this.io.to(workspaceId).emit("users_connected", connectedUsers);

        // Registrar métricas
        metricsService.userLeftWorkspace(workspaceId, userData.id);
      }

      metricsService.messageProcessed(
        "leave_workspace",
        Date.now() - startTime
      );

      logger.info(
        {
          socketId: socket.id,
          userId: userData?.id,
          workspaceId,
        },
        "Usuario salió del workspace correctamente"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al salir del workspace"
      );

      metricsService.errorOccurred("leave_workspace", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al salir del workspace",
        details: error.message,
      });
    }
  }

  /**
   * Maneja el evento de obtener usuarios de un workspace
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async handleGetWorkspaceUsers(socket, workspaceId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
        },
        "Solicitando usuarios del workspace"
      );

      // Obtener usuarios de Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const workspaceUsers = (await redisService.get(redisKey)) || {};
      const allUsers = Object.values(workspaceUsers);
      const connectedUsers = this.removeDuplicateUsers(allUsers);

      socket.emit("users_connected", connectedUsers);

      metricsService.messageProcessed(
        "get_workspace_users",
        Date.now() - startTime
      );

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          userCount: connectedUsers.length,
        },
        "Usuarios del workspace enviados"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al obtener usuarios del workspace"
      );

      metricsService.errorOccurred("get_workspace_users", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al obtener usuarios",
        details: error.message,
      });
    }
  }

  /**
   * Elimina usuarios duplicados basándose en el email
   * @param {Array} users - Array de usuarios
   * @returns {Array} Array de usuarios sin duplicados
   */
  removeDuplicateUsers(users) {
    const uniqueUsers = [];
    const seenEmails = new Set();

    for (const user of users) {
      if (!seenEmails.has(user.email)) {
        seenEmails.add(user.email);
        uniqueUsers.push(user);
      }
    }

    return uniqueUsers;
  }

  /**
   * Función de limpieza periódica para eliminar usuarios duplicados
   */
  async cleanupDuplicateUsers() {
    try {
      // Limpiar memoria local
      Object.keys(workspaceSockets).forEach((workspaceId) => {
        const userMap = workspaceSockets[workspaceId];
        const emailToSocket = new Map();
        const socketsToRemove = [];

        // Identificar duplicados - mantener el más reciente
        for (const [socketId, userData] of userMap) {
          if (emailToSocket.has(userData.email)) {
            // Duplicado encontrado, marcar el anterior para eliminación
            socketsToRemove.push(emailToSocket.get(userData.email));
          }
          emailToSocket.set(userData.email, socketId);
        }

        // Eliminar duplicados
        socketsToRemove.forEach((socketId) => {
          userMap.delete(socketId);
          logger.info(
            {
              socketId,
              workspaceId,
            },
            "Usuario duplicado eliminado en limpieza periódica"
          );
        });
      });

      // Limpiar Redis
      const workspaceKeys = await redisService.keys(
        `${this.REDIS_PREFIX}*:users`
      );
      for (const key of workspaceKeys) {
        const workspaceUsers = (await redisService.get(key)) || {};
        const usersByEmail = new Map();
        const socketsToRemove = [];

        // Identificar duplicados
        Object.entries(workspaceUsers).forEach(([socketId, userData]) => {
          if (usersByEmail.has(userData.email)) {
            socketsToRemove.push(usersByEmail.get(userData.email));
          }
          usersByEmail.set(userData.email, socketId);
        });

        // Eliminar duplicados de Redis
        if (socketsToRemove.length > 0) {
          socketsToRemove.forEach((socketId) => {
            delete workspaceUsers[socketId];
          });
          await redisService.set(key, workspaceUsers);

          logger.info(
            {
              workspaceKey: key,
              removedSockets: socketsToRemove.length,
            },
            "Usuarios duplicados eliminados de Redis"
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
        },
        "Error en limpieza periódica de usuarios duplicados"
      );
    }
  }

  /**
   * Maneja la desconexión de un usuario
   * @param {Object} socket - Socket de conexión
   */
  handleDisconnect(socket) {
    try {
      // Buscar en qué workspaces estaba el usuario
      Object.keys(workspaceSockets).forEach(async (workspaceId) => {
        if (workspaceSockets[workspaceId].has(socket.id)) {
          const userData = workspaceSockets[workspaceId].get(socket.id);

          // Programar desconexión con delay de 5 segundos para permitir reconexión
          const timeout = setTimeout(async () => {
            // Verificar si el usuario sigue desconectado
            if (pendingDisconnections.has(socket.id)) {
              pendingDisconnections.delete(socket.id);
              await this.handleLeaveWorkspace(socket, workspaceId);
              logger.info(
                {
                  socketId: socket.id,
                  userEmail: userData.email,
                  workspaceId,
                },
                "Desconexión confirmada después del delay"
              );
            }
          }, 5000); // 5 segundos de delay

          pendingDisconnections.set(socket.id, {
            userData,
            workspaceId,
            timeout,
          });

          logger.info(
            {
              socketId: socket.id,
              userEmail: userData.email,
              workspaceId,
            },
            "Desconexión programada con delay de 5 segundos"
          );
        }
      });
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar desconexión de workspace"
      );
    }
  }
}

module.exports = WorkspaceHandler;
