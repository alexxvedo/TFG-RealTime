const logger = require("../../utils/logger");
const metricsService = require("../../services/metrics");
const redisService = require("../../services/redis");

// Almacenamiento en memoria (se reemplazará gradualmente por Redis)
const collectionUsers = new Map(); // workspaceId -> Map(collectionId -> Map(socketId -> userData))

/**
 * Clase para manejar eventos relacionados con colecciones
 */
class CollectionHandler {
  /**
   * Inicializa el handler con la instancia de socket.io
   * @param {Object} io - Instancia de Socket.IO
   */
  constructor(io) {
    this.io = io;
    this.REDIS_PREFIX = "collection:";
  }

  /**
   * Registra todos los manejadores de eventos para colecciones
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on("join_collection", (workspaceId, collectionId, userData) =>
      this.handleJoinCollection(socket, workspaceId, collectionId, userData)
    );

    socket.on("leave_collection", (workspaceId, collectionId) =>
      this.handleLeaveCollection(socket, workspaceId, collectionId)
    );

    socket.on("get_collections_users", (workspaceId) =>
      this.handleGetCollectionsUsers(socket, workspaceId)
    );
  }

  /**
   * Maneja el evento de unirse a una colección
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} collectionId - ID de la colección
   * @param {Object} userData - Datos del usuario
   */
  async handleJoinCollection(socket, workspaceId, collectionId, userData) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          userId: userData.id,
          email: userData.email,
          workspaceId,
          collectionId,
        },
        "Usuario uniéndose a la colección"
      );

      // Estructura en memoria local (para compatibilidad)
      if (!collectionUsers.has(workspaceId)) {
        collectionUsers.set(workspaceId, new Map());
      }

      if (!collectionUsers.get(workspaceId).has(collectionId)) {
        collectionUsers.get(workspaceId).set(collectionId, new Map());
      }

      const collectionUserMap = collectionUsers
        .get(workspaceId)
        .get(collectionId);

      // Verificar si el usuario ya está en la colección
      const existingUserData = Array.from(collectionUserMap.values()).find(
        (user) => user.email === userData.email
      );

      if (!existingUserData) {
        // Añadir usuario a la colección en memoria local
        collectionUserMap.set(socket.id, userData);

        // Añadir usuario a la colección en Redis
        const redisKey = `${this.REDIS_PREFIX}${workspaceId}:${collectionId}:users`;
        const collectionRedisUsers = (await redisService.get(redisKey)) || {};
        collectionRedisUsers[socket.id] = userData;
        await redisService.set(redisKey, collectionRedisUsers);

        // Unir al socket a la sala de la colección
        const roomName = `${workspaceId}:${collectionId}`;
        socket.join(roomName);

        // Obtener usuarios en la colección
        const usersInCollection = Object.values(collectionRedisUsers);

        // Eliminar usuarios duplicados basados en email
        const uniqueUsers = Array.from(
          new Map(usersInCollection.map((user) => [user.email, user])).values()
        );

        // Notificar a todos los usuarios del workspace
        this.io.to(workspaceId).emit("collection_user_joined", {
          collectionId,
          userData: userData,
        });

        this.io.to(workspaceId).emit("collection_users_updated", {
          collectionId,
          users: uniqueUsers,
        });

        logger.info(
          {
            socketId: socket.id,
            userId: userData.id,
            workspaceId,
            collectionId,
            userCount: uniqueUsers.length,
          },
          "Usuario unido a la colección correctamente"
        );
      } else {
        logger.info(
          {
            socketId: socket.id,
            userId: userData.id,
            workspaceId,
            collectionId,
          },
          "Usuario ya está en la colección"
        );
      }

      metricsService.messageProcessed(
        "join_collection",
        Date.now() - startTime
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
          collectionId,
        },
        "Error al unirse a la colección"
      );

      metricsService.errorOccurred("join_collection", {
        socketId: socket.id,
        workspaceId,
        collectionId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al unirse a la colección",
        details: error.message,
      });
    }
  }

  /**
   * Maneja el evento de salir de una colección
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} collectionId - ID de la colección
   */
  async handleLeaveCollection(socket, workspaceId, collectionId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          collectionId,
        },
        "Usuario saliendo de la colección"
      );

      // Verificar si la colección existe en memoria local
      if (
        collectionUsers.has(workspaceId) &&
        collectionUsers.get(workspaceId).has(collectionId)
      ) {
        const collectionUserMap = collectionUsers
          .get(workspaceId)
          .get(collectionId);
        const userData = collectionUserMap.get(socket.id);

        if (userData) {
          // Eliminar usuario de la colección en memoria local
          collectionUserMap.delete(socket.id);

          // Eliminar usuario de la colección en Redis
          const redisKey = `${this.REDIS_PREFIX}${workspaceId}:${collectionId}:users`;
          const collectionRedisUsers = (await redisService.get(redisKey)) || {};
          delete collectionRedisUsers[socket.id];
          await redisService.set(redisKey, collectionRedisUsers);

          // Salir de la sala de la colección
          const roomName = `${workspaceId}:${collectionId}`;
          socket.leave(roomName);

          // Obtener usuarios actualizados en la colección
          const usersInCollection = Object.values(collectionRedisUsers);

          // Eliminar usuarios duplicados basados en email
          const uniqueUsers = Array.from(
            new Map(
              usersInCollection.map((user) => [user.email, user])
            ).values()
          );

          // Notificar a todos los usuarios del workspace
          this.io.to(workspaceId).emit("collection_user_left", {
            collectionId,
            userData: userData,
          });

          this.io.to(workspaceId).emit("collection_users_updated", {
            collectionId,
            users: uniqueUsers,
          });

          // Limpiar colecciones vacías
          if (Object.keys(collectionRedisUsers).length === 0) {
            await redisService.delete(redisKey);
            collectionUsers.get(workspaceId).delete(collectionId);

            if (collectionUsers.get(workspaceId).size === 0) {
              collectionUsers.delete(workspaceId);
            }
          }

          logger.info(
            {
              socketId: socket.id,
              userId: userData.id,
              workspaceId,
              collectionId,
              userCount: uniqueUsers.length,
            },
            "Usuario salió de la colección correctamente"
          );
        } else {
          logger.info(
            {
              socketId: socket.id,
              workspaceId,
              collectionId,
            },
            "No se encontraron datos del usuario en la colección"
          );
        }
      }

      metricsService.messageProcessed(
        "leave_collection",
        Date.now() - startTime
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
          collectionId,
        },
        "Error al salir de la colección"
      );

      metricsService.errorOccurred("leave_collection", {
        socketId: socket.id,
        workspaceId,
        collectionId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al salir de la colección",
        details: error.message,
      });
    }
  }

  /**
   * Maneja el evento de obtener usuarios de todas las colecciones de un workspace
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async handleGetCollectionsUsers(socket, workspaceId) {
    const startTime = Date.now();

    try {
      logger.info(
        {
          socketId: socket.id,
          workspaceId,
        },
        "Solicitando usuarios de colecciones"
      );

      // Buscar todas las claves de colecciones en Redis
      const pattern = `${this.REDIS_PREFIX}${workspaceId}:*:users`;
      const keys = await redisService.client.keys(pattern);

      // Para cada colección, obtener los usuarios y enviarlos
      for (const key of keys) {
        // Extraer collectionId del key (formato: collection:workspaceId:collectionId:users)
        const parts = key.split(":");
        const collectionId = parts[2];

        // Obtener usuarios de la colección
        const collectionUsers = (await redisService.get(key)) || {};
        const usersInCollection = Object.values(collectionUsers);

        // Eliminar usuarios duplicados basados en email
        const uniqueUsers = Array.from(
          new Map(usersInCollection.map((user) => [user.email, user])).values()
        );

        // Enviar información al cliente
        socket.emit("collection_users_updated", {
          collectionId,
          users: uniqueUsers,
        });
      }

      metricsService.messageProcessed(
        "get_collections_users",
        Date.now() - startTime
      );

      logger.info(
        {
          socketId: socket.id,
          workspaceId,
          collectionsCount: keys.length,
        },
        "Usuarios de colecciones enviados"
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
          workspaceId,
        },
        "Error al obtener usuarios de colecciones"
      );

      metricsService.errorOccurred("get_collections_users", {
        socketId: socket.id,
        workspaceId,
        error: error.message,
      });

      socket.emit("error", {
        message: "Error al obtener usuarios de colecciones",
        details: error.message,
      });
    }
  }

  /**
   * Maneja la desconexión de un usuario
   * @param {Object} socket - Socket de conexión
   */
  async handleDisconnect(socket) {
    try {
      logger.info(
        {
          socketId: socket.id,
        },
        "Manejando desconexión de usuario de colecciones"
      );

      // Buscar en qué colecciones estaba el usuario
      const workspacesToCheck = Array.from(collectionUsers.keys());

      for (const workspaceId of workspacesToCheck) {
        const workspaceCollections = collectionUsers.get(workspaceId);
        const collectionsToCheck = Array.from(workspaceCollections.keys());

        for (const collectionId of collectionsToCheck) {
          const collectionUserMap = workspaceCollections.get(collectionId);

          if (collectionUserMap.has(socket.id)) {
            logger.info(
              {
                socketId: socket.id,
                workspaceId,
                collectionId,
              },
              "Usuario encontrado en colección, procesando desconexión"
            );

            // Llamar a handleLeaveCollection para cada colección
            await this.handleLeaveCollection(socket, workspaceId, collectionId);
          }
        }

        // Verificar también en Redis por si acaso
        const pattern = `${this.REDIS_PREFIX}${workspaceId}:*:users`;
        const keys = await redisService.client.keys(pattern);

        for (const key of keys) {
          // Extraer collectionId del key (formato: collection:workspaceId:collectionId:users)
          const parts = key.split(":");
          const collectionId = parts[2];

          // Obtener usuarios de la colección
          const collectionRedisUsers = (await redisService.get(key)) || {};

          // Si el socket está en Redis pero no en memoria, limpiarlo
          if (collectionRedisUsers[socket.id]) {
            logger.info(
              {
                socketId: socket.id,
                workspaceId,
                collectionId,
              },
              "Usuario encontrado en Redis pero no en memoria, limpiando"
            );

            // Obtener datos del usuario
            const userData = collectionRedisUsers[socket.id];

            // Eliminar usuario de Redis
            delete collectionRedisUsers[socket.id];
            await redisService.set(key, collectionRedisUsers);

            // Obtener usuarios actualizados
            const usersInCollection = Object.values(collectionRedisUsers);

            // Eliminar usuarios duplicados basados en email
            const uniqueUsers = Array.from(
              new Map(
                usersInCollection.map((user) => [user.email, user])
              ).values()
            );

            // Notificar a todos los usuarios del workspace
            this.io.to(workspaceId).emit("collection_user_left", {
              collectionId,
              userData: userData,
            });

            this.io.to(workspaceId).emit("collection_users_updated", {
              collectionId,
              users: uniqueUsers,
            });

            // Limpiar colecciones vacías
            if (Object.keys(collectionRedisUsers).length === 0) {
              await redisService.delete(key);
            }
          }
        }
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
          socketId: socket.id,
        },
        "Error al manejar desconexión de colecciones"
      );
    }
  }
}

module.exports = CollectionHandler;
