const logger = require("../../utils/logger");
const metricsService = require("../../services/metrics");
const redisService = require("../../services/redis");

// Almacenamiento en memoria para usuarios viendo la agenda
const agendaUsers = new Map(); // workspaceId -> Map(socketId -> userData)

/**
 * Clase para manejar eventos relacionados con tareas/agenda
 */
class TaskHandler {
  /**
   * Inicializa el handler con la instancia de socket.io
   * @param {Object} io - Instancia de Socket.IO
   */
  constructor(io) {
    this.io = io;
    this.REDIS_PREFIX = "task:";
  }

  /**
   * Registra todos los manejadores de eventos para tareas
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on("join_agenda", (workspaceId, userData) =>
      this.handleJoinAgenda(socket, workspaceId, userData)
    );
    socket.on("leave_agenda", (workspaceId) =>
      this.handleLeaveAgenda(socket, workspaceId)
    );
    socket.on("task_created", (taskData) =>
      this.handleTaskCreated(socket, taskData)
    );
    socket.on("task_updated", (taskData) =>
      this.handleTaskUpdated(socket, taskData)
    );
    socket.on("task_deleted", (taskData) =>
      this.handleTaskDeleted(socket, taskData)
    );
    socket.on("task_moved", (taskData) =>
      this.handleTaskMoved(socket, taskData)
    );
    socket.on("get_agenda_users", (workspaceId) =>
      this.handleGetAgendaUsers(socket, workspaceId)
    );
  }

  /**
   * Maneja el evento de unirse a la agenda
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {Object} userData - Datos del usuario
   */
  async handleJoinAgenda(socket, workspaceId, userData) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          userId: userData.id,
          email: userData.email,
          workspaceId,
        },
        "Usuario uniéndose a la agenda"
      );

      // Guardar en memoria local
      if (!agendaUsers.has(workspaceId)) {
        agendaUsers.set(workspaceId, new Map());
      }
      agendaUsers.get(workspaceId).set(socket.id, userData);

      // Guardar en Redis para escalabilidad horizontal
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:agenda_users`;
      const agendaRedisUsers = (await redisService.get(redisKey)) || {};
      agendaRedisUsers[socket.id] = userData;
      await redisService.set(redisKey, agendaRedisUsers);

      // Unir al socket a la sala de la agenda
      const roomName = `agenda:${workspaceId}`;
      socket.join(roomName);

      // Obtener usuarios en la agenda
      const usersInAgenda = Object.values(agendaRedisUsers);

      // Notificar a todos los usuarios del workspace sobre la agenda
      this.io.to(`workspace:${workspaceId}`).emit("agenda_user_joined", {
        workspaceId,
        userData: userData,
      });

      this.io.to(roomName).emit("agenda_users_updated", {
        workspaceId,
        users: usersInAgenda,
      });

      metricsService.messageProcessed("join_agenda", Date.now() - startTime);

      logger.info(
        {
          socketId: socket.id,
          userId: userData.id,
          workspaceId,
          userCount: usersInAgenda.length,
        },
        "Usuario unido a la agenda correctamente"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al unirse a la agenda"
      );

      metricsService.errorOccurred("join_agenda", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al unirse a la agenda",
        details: error.message,
      });
    }
  }

  /**
   * Maneja el evento de salir de la agenda
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async handleLeaveAgenda(socket, workspaceId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
        },
        "Usuario saliendo de la agenda"
      );

      // Obtener datos del usuario de la memoria local
      let userData = null;
      if (agendaUsers.has(workspaceId)) {
        userData = agendaUsers.get(workspaceId).get(socket.id);
        agendaUsers.get(workspaceId).delete(socket.id);
      }

      // Actualizar en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:agenda_users`;
      const agendaRedisUsers = (await redisService.get(redisKey)) || {};

      if (agendaRedisUsers[socket.id]) {
        userData = userData || agendaRedisUsers[socket.id];
        delete agendaRedisUsers[socket.id];
        await redisService.set(redisKey, agendaRedisUsers);
      }

      // Salir de la sala
      const roomName = `agenda:${workspaceId}`;
      socket.leave(roomName);

      // Notificar a los demás usuarios
      if (userData) {
        this.io.to(`workspace:${workspaceId}`).emit("agenda_user_left", {
          workspaceId,
          userData: userData,
        });

        // Actualizar lista de usuarios en la agenda
        const usersInAgenda = Object.values(agendaRedisUsers);
        this.io.to(roomName).emit("agenda_users_updated", {
          workspaceId,
          users: usersInAgenda,
        });
      }

      metricsService.messageProcessed("leave_agenda", Date.now() - startTime);

      logger.info(
        {
          socketId: socket.id,
          userId: userData?.id,
          workspaceId,
        },
        "Usuario salió de la agenda correctamente"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al salir de la agenda"
      );

      metricsService.errorOccurred("leave_agenda", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });
    }
  }

  /**
   * Maneja el evento de tarea creada
   * @param {Object} socket - Socket de conexión
   * @param {Object} taskData - Datos de la tarea creada
   */
  async handleTaskCreated(socket, taskData) {
    const startTime = Date.now();

    try {
      const { workspaceId, task, createdBy } = taskData;

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          taskId: task.id,
          createdBy: createdBy?.email,
        },
        "Tarea creada"
      );

      // Emitir a todos los usuarios en la agenda del workspace
      const roomName = `agenda:${workspaceId}`;
      socket.to(roomName).emit("task_created", {
        workspaceId,
        task,
        createdBy,
        timestamp: new Date().toISOString(),
      });

      // También emitir a todos los usuarios del workspace por si están en otras páginas
      this.io.to(`workspace:${workspaceId}`).emit("workspace_task_created", {
        workspaceId,
        task,
        createdBy,
        timestamp: new Date().toISOString(),
      });

      metricsService.messageProcessed("task_created", Date.now() - startTime);
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar tarea creada"
      );

      metricsService.errorOccurred("task_created", {
        socketId: socket.id,
        error: error.message,
      });
    }
  }

  /**
   * Maneja el evento de tarea actualizada
   * @param {Object} socket - Socket de conexión
   * @param {Object} taskData - Datos de la tarea actualizada
   */
  async handleTaskUpdated(socket, taskData) {
    const startTime = Date.now();

    try {
      const { workspaceId, task, updatedBy, changes } = taskData;

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          taskId: task.id,
          updatedBy: updatedBy?.email,
          changes: Object.keys(changes || {}),
        },
        "Tarea actualizada"
      );

      // Emitir a todos los usuarios en la agenda del workspace excepto al remitente
      const roomName = `agenda:${workspaceId}`;
      socket.to(roomName).emit("task_updated", {
        workspaceId,
        task,
        updatedBy,
        changes,
        timestamp: new Date().toISOString(),
      });

      // También emitir a todos los usuarios del workspace
      this.io.to(`workspace:${workspaceId}`).emit("workspace_task_updated", {
        workspaceId,
        task,
        updatedBy,
        changes,
        timestamp: new Date().toISOString(),
      });

      metricsService.messageProcessed("task_updated", Date.now() - startTime);
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar tarea actualizada"
      );

      metricsService.errorOccurred("task_updated", {
        socketId: socket.id,
        error: error.message,
      });
    }
  }

  /**
   * Maneja el evento de tarea eliminada
   * @param {Object} socket - Socket de conexión
   * @param {Object} taskData - Datos de la tarea eliminada
   */
  async handleTaskDeleted(socket, taskData) {
    const startTime = Date.now();

    try {
      const { workspaceId, taskId, deletedBy } = taskData;

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          taskId,
          deletedBy: deletedBy?.email,
        },
        "Tarea eliminada"
      );

      // Emitir a todos los usuarios en la agenda del workspace excepto al remitente
      const roomName = `agenda:${workspaceId}`;
      socket.to(roomName).emit("task_deleted", {
        workspaceId,
        taskId,
        deletedBy,
        timestamp: new Date().toISOString(),
      });

      // También emitir a todos los usuarios del workspace
      this.io.to(`workspace:${workspaceId}`).emit("workspace_task_deleted", {
        workspaceId,
        taskId,
        deletedBy,
        timestamp: new Date().toISOString(),
      });

      metricsService.messageProcessed("task_deleted", Date.now() - startTime);
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar tarea eliminada"
      );

      metricsService.errorOccurred("task_deleted", {
        socketId: socket.id,
        error: error.message,
      });
    }
  }

  /**
   * Maneja el evento de tarea movida (cambio de estado)
   * @param {Object} socket - Socket de conexión
   * @param {Object} taskData - Datos del movimiento de tarea
   */
  async handleTaskMoved(socket, taskData) {
    const startTime = Date.now();

    try {
      const { workspaceId, taskId, fromStatus, toStatus, task, movedBy } =
        taskData;

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          taskId,
          fromStatus,
          toStatus,
          movedBy: movedBy?.email,
        },
        "Tarea movida"
      );

      // Emitir a todos los usuarios en la agenda del workspace excepto al remitente
      const roomName = `agenda:${workspaceId}`;
      socket.to(roomName).emit("task_moved", {
        workspaceId,
        taskId,
        fromStatus,
        toStatus,
        task,
        movedBy,
        timestamp: new Date().toISOString(),
      });

      // También emitir a todos los usuarios del workspace
      this.io.to(`workspace:${workspaceId}`).emit("workspace_task_moved", {
        workspaceId,
        taskId,
        fromStatus,
        toStatus,
        task,
        movedBy,
        timestamp: new Date().toISOString(),
      });

      metricsService.messageProcessed("task_moved", Date.now() - startTime);
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar tarea movida"
      );

      metricsService.errorOccurred("task_moved", {
        socketId: socket.id,
        error: error.message,
      });
    }
  }

  /**
   * Maneja el evento de obtener usuarios en la agenda
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async handleGetAgendaUsers(socket, workspaceId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
        },
        "Solicitando usuarios en la agenda"
      );

      // Obtener usuarios de Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:agenda_users`;
      const agendaRedisUsers = (await redisService.get(redisKey)) || {};
      const usersInAgenda = Object.values(agendaRedisUsers);

      socket.emit("agenda_users_updated", {
        workspaceId,
        users: usersInAgenda,
      });

      metricsService.messageProcessed(
        "get_agenda_users",
        Date.now() - startTime
      );

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          userCount: usersInAgenda.length,
        },
        "Usuarios de la agenda enviados"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al obtener usuarios de la agenda"
      );

      metricsService.errorOccurred("get_agenda_users", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al obtener usuarios de la agenda",
        details: error.message,
      });
    }
  }

  /**
   * Maneja la desconexión de un usuario
   * @param {Object} socket - Socket de conexión
   */
  handleDisconnect(socket) {
    try {
      // Limpiar de todas las agendas donde esté el usuario
      agendaUsers.forEach(async (workspaceUsers, workspaceId) => {
        if (workspaceUsers.has(socket.id)) {
          const userData = workspaceUsers.get(socket.id);
          workspaceUsers.delete(socket.id);

          // Actualizar en Redis
          const redisKey = `${this.REDIS_PREFIX}${workspaceId}:agenda_users`;
          const agendaRedisUsers = (await redisService.get(redisKey)) || {};
          delete agendaRedisUsers[socket.id];
          await redisService.set(redisKey, agendaRedisUsers);

          // Notificar a otros usuarios
          const roomName = `agenda:${workspaceId}`;
          this.io.to(roomName).emit("agenda_user_left", {
            workspaceId,
            userData: userData,
          });

          const usersInAgenda = Object.values(agendaRedisUsers);
          this.io.to(roomName).emit("agenda_users_updated", {
            workspaceId,
            users: usersInAgenda,
          });
        }
      });
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar desconexión de agenda"
      );
    }
  }
}

module.exports = TaskHandler;
