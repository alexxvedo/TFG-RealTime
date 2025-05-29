const logger = require('../../utils/logger');
const metricsService = require('../../services/metrics');
const redisService = require('../../services/redis');

// Almacenamiento en memoria (se reemplazará gradualmente por Redis)
const workspaceSockets = {}; // workspaceId -> Map(socketId -> userData)
const userLastSeen = new Map(); // workspaceId -> Map<userId -> timestamp)

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
    this.REDIS_PREFIX = 'workspace:';
  }

  /**
   * Registra todos los manejadores de eventos para workspaces
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on('join_workspace', (workspaceId, userData) => this.handleJoinWorkspace(socket, workspaceId, userData));
    socket.on('leave_workspace', (workspaceId) => this.handleLeaveWorkspace(socket, workspaceId));
    socket.on('get_workspace_users', (workspaceId) => this.handleGetWorkspaceUsers(socket, workspaceId));
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
      logger.info({
        socketId: socket.id,
        userId: userData.id,
        email: userData.email,
        workspaceId
      }, 'Usuario uniéndose al workspace');

      // Guardar en memoria local (para compatibilidad)
      if (!workspaceSockets[workspaceId]) {
        workspaceSockets[workspaceId] = new Map();
      }
      workspaceSockets[workspaceId].set(socket.id, userData);

      // Guardar en Redis para escalabilidad horizontal
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const workspaceUsers = await redisService.get(redisKey) || {};
      workspaceUsers[socket.id] = userData;
      await redisService.set(redisKey, workspaceUsers);

      // Actualizar última vez visto
      if (!userLastSeen.has(workspaceId)) {
        userLastSeen.set(workspaceId, new Map());
      }
      userLastSeen.get(workspaceId).set(userData.email, new Date());

      // Unir al socket a la sala del workspace
      socket.join(workspaceId);

      // Obtener usuarios conectados
      const connectedUsers = Object.values(workspaceUsers);
      
      // Notificar a todos los usuarios del workspace
      this.io.to(workspaceId).emit('users_connected', connectedUsers);
      this.io.to(workspaceId).emit('user_joined', userData);

      // Registrar métricas
      metricsService.userJoinedWorkspace(workspaceId, userData.id);
      metricsService.messageProcessed('join_workspace', Date.now() - startTime);

      logger.info({
        socketId: socket.id,
        userId: userData.id,
        workspaceId,
        userCount: connectedUsers.length
      }, 'Usuario unido al workspace correctamente');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId
      }, 'Error al unirse al workspace');
      
      metricsService.errorOccurred('join_workspace', { 
        socketId: socket.id, 
        workspaceId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al unirse al workspace', details: error.message });
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
      logger.info({
        socketId: socket.id,
        workspaceId
      }, 'Usuario saliendo del workspace');

      // Obtener datos del usuario de la memoria local
      let userData = null;
      if (workspaceSockets[workspaceId]) {
        userData = workspaceSockets[workspaceId].get(socket.id);
        workspaceSockets[workspaceId].delete(socket.id);
      }

      // Actualizar en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const workspaceUsers = await redisService.get(redisKey) || {};
      
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
        this.io.to(workspaceId).emit('user_left', userData);
        
        // Actualizar lista de usuarios conectados
        const connectedUsers = Object.values(workspaceUsers);
        this.io.to(workspaceId).emit('users_connected', connectedUsers);
        
        // Registrar métricas
        metricsService.userLeftWorkspace(workspaceId, userData.id);
      }
      
      metricsService.messageProcessed('leave_workspace', Date.now() - startTime);

      logger.info({
        socketId: socket.id,
        userId: userData?.id,
        workspaceId
      }, 'Usuario salió del workspace correctamente');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId
      }, 'Error al salir del workspace');
      
      metricsService.errorOccurred('leave_workspace', { 
        socketId: socket.id, 
        workspaceId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al salir del workspace', details: error.message });
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
      logger.info({
        socketId: socket.id,
        workspaceId
      }, 'Solicitando usuarios del workspace');

      // Obtener usuarios de Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:users`;
      const workspaceUsers = await redisService.get(redisKey) || {};
      const connectedUsers = Object.values(workspaceUsers);

      socket.emit('users_connected', connectedUsers);
      
      metricsService.messageProcessed('get_workspace_users', Date.now() - startTime);

      logger.info({
        socketId: socket.id,
        workspaceId,
        userCount: connectedUsers.length
      }, 'Usuarios del workspace enviados');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId
      }, 'Error al obtener usuarios del workspace');
      
      metricsService.errorOccurred('get_workspace_users', { 
        socketId: socket.id, 
        workspaceId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al obtener usuarios', details: error.message });
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
          // Llamar a handleLeaveWorkspace para cada workspace
          await this.handleLeaveWorkspace(socket, workspaceId);
        }
      });
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al manejar desconexión de workspace');
    }
  }
}

module.exports = WorkspaceHandler;
