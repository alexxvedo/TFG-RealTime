const logger = require('../../utils/logger');
const metricsService = require('../../services/metrics');
const redisService = require('../../services/redis');

// Almacenamiento en memoria (se reemplazará gradualmente por Redis)
const noteUsers = new Map(); // noteId -> Array<{id, userData}>
const noteContents = new Map(); // noteId -> content

/**
 * Clase para manejar eventos relacionados con notas colaborativas
 */
class NoteHandler {
  /**
   * Inicializa el handler con la instancia de socket.io
   * @param {Object} io - Instancia de Socket.IO
   */
  constructor(io) {
    this.io = io;
    this.REDIS_PREFIX = 'note:';
  }

  /**
   * Registra todos los manejadores de eventos para notas
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on('join_note', (workspaceId, noteId, userData) => {
      console.log('join_note recibido:', { workspaceId, noteId, userData });
      this.handleJoinNote(socket, workspaceId, noteId, userData);
    });
    socket.on('leave_note', (workspaceId, noteId) => {
      console.log('leave_note recibido:', { workspaceId, noteId });
      this.handleLeaveNote(socket, workspaceId, noteId);
    });
    socket.on('cursor_update', (workspaceId, noteId, cursorData) => {
      // No logueamos cada actualización de cursor para evitar spam
      this.handleCursorUpdate(socket, workspaceId, noteId, cursorData);
    });
    socket.on('note_content_update', (workspaceId, noteId, content) => {
      console.log('note_content_update recibido:', { workspaceId, noteId, contentLength: content?.length });
      this.handleContentUpdate(socket, workspaceId, noteId, content);
    });
  }

  /**
   * Maneja el evento de unirse a una nota
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} noteId - ID de la nota
   * @param {Object} userData - Datos del usuario
   */
  async handleJoinNote(socket, workspaceId, noteId, userData) {
    const startTime = Date.now();
    
    try {
      logger.info({
        socketId: socket.id,
        userId: userData.id,
        email: userData.email,
        workspaceId,
        noteId
      }, 'Usuario uniéndose a la nota');

      // Crear sala para la nota
      const roomName = `note:${workspaceId}:${noteId}`;
      socket.join(roomName);
      
      // Guardar usuario en memoria local
      if (!noteUsers.has(noteId)) {
        noteUsers.set(noteId, []);
      }
      
      const usersList = noteUsers.get(noteId);
      
      // Verificar si el usuario ya está en la nota
      const existingUserIndex = usersList.findIndex(u => u.userData.id === userData.id);
      
      if (existingUserIndex >= 0) {
        // Actualizar socket.id si el usuario ya existe
        usersList[existingUserIndex].id = socket.id;
      } else {
        // Añadir nuevo usuario
        usersList.push({ id: socket.id, userData });
      }
      
      // Guardar en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:${noteId}:users`;
      await redisService.set(redisKey, usersList);
      
      // Enviar contenido actual de la nota al usuario
      let content = noteContents.get(noteId);
      
      // Si no está en memoria local, intentar obtener de Redis
      if (!content) {
        const redisContentKey = `${this.REDIS_PREFIX}${workspaceId}:${noteId}:content`;
        content = await redisService.get(redisContentKey);
        
        // Si se encontró en Redis, actualizar memoria local
        if (content) {
          noteContents.set(noteId, content);
        }
      }
      
      // Enviar contenido al usuario que se une
      socket.emit('note_content_loaded', {
        noteId,
        content: content || ''
      });
      
      // Notificar a todos los usuarios de la nota
      this.io.to(roomName).emit('note_users_updated', {
        noteId,
        users: usersList.map(u => u.userData)
      });
      
      metricsService.messageProcessed('join_note', Date.now() - startTime);
      
      logger.info({
        socketId: socket.id,
        userId: userData.id,
        workspaceId,
        noteId,
        userCount: usersList.length
      }, 'Usuario unido a la nota correctamente');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId,
        noteId
      }, 'Error al unirse a la nota');
      
      metricsService.errorOccurred('join_note', { 
        socketId: socket.id, 
        workspaceId,
        noteId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al unirse a la nota', details: error.message });
    }
  }

  /**
   * Maneja el evento de salir de una nota
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} noteId - ID de la nota
   */
  async handleLeaveNote(socket, workspaceId, noteId) {
    try {
      logger.info({
        socketId: socket.id,
        workspaceId,
        noteId
      }, 'Usuario saliendo de la nota');
      
      // Verificar si la nota existe
      if (noteUsers.has(noteId)) {
        const usersList = noteUsers.get(noteId);
        
        // Buscar al usuario por socket.id
        const userIndex = usersList.findIndex(u => u.id === socket.id);
        
        if (userIndex >= 0) {
          // Guardar datos del usuario antes de eliminarlo
          const userData = usersList[userIndex].userData;
          
          // Eliminar al usuario de la lista
          usersList.splice(userIndex, 1);
          
          // Actualizar en Redis
          const redisKey = `${this.REDIS_PREFIX}${workspaceId}:${noteId}:users`;
          await redisService.set(redisKey, usersList);
          
          // Abandonar la sala
          const roomName = `note:${workspaceId}:${noteId}`;
          socket.leave(roomName);
          
          // Notificar a todos los usuarios restantes
          this.io.to(roomName).emit('note_users_updated', {
            noteId,
            users: usersList.map(u => u.userData)
          });
          
          // Notificar que el cursor de este usuario ya no está activo
          socket.to(roomName).emit('cursor_updated', {
            noteId,
            userId: socket.id,
            userData,
            cursor: null // Cursor nulo indica que se debe eliminar
          });
          
          logger.info({
            socketId: socket.id,
            workspaceId,
            noteId,
            remainingUsers: usersList.length
          }, 'Usuario ha salido de la nota');
        }
      }
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId,
        noteId
      }, 'Error al salir de la nota');
      
      metricsService.errorOccurred('leave_note', { 
        socketId: socket.id, 
        workspaceId,
        noteId, 
        error: error.message 
      });
    }
  }

  /**
   * Maneja el evento de actualización de cursor
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} noteId - ID de la nota
   * @param {Object} cursorData - Datos del cursor
   */
  async handleCursorUpdate(socket, workspaceId, noteId, cursorData) {
    try {
      console.log("Cursor update recibido:", {
        socketId: socket.id,
        workspaceId,
        noteId,
        cursorData
      });
      
      // Buscar el usuario en la nota
      if (noteUsers.has(noteId)) {
        const usersList = noteUsers.get(noteId);
        const user = usersList.find(u => u.id === socket.id);
        
        if (!user) {
          logger.debug({
            socketId: socket.id,
            workspaceId,
            noteId
          }, 'Usuario no encontrado en la nota para actualización de cursor');
          return;
        }
        
        // Emitir la actualización del cursor a TODOS los usuarios en la nota (incluyendo al remitente)
        const roomName = `note:${workspaceId}:${noteId}`;
        const eventData = {
          noteId,
          userId: socket.id,
          userData: user.userData,
          cursor: cursorData
        };
        
        // Emitir a todos en la sala, incluyendo al remitente
        this.io.in(roomName).emit('cursor_updated', eventData);
        
        console.log("Cursor updated emitido a todos:", {
          room: roomName,
          eventData
        });
        
        metricsService.messageProcessed('cursor_update');
      }
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId,
        noteId
      }, 'Error al actualizar cursor');
      
      metricsService.errorOccurred('cursor_update', { 
        socketId: socket.id, 
        workspaceId,
        noteId, 
        error: error.message 
      });
    }
  }

  /**
   * Maneja el evento de actualización de contenido de nota
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   * @param {string} noteId - ID de la nota
   * @param {string} content - Contenido actualizado
   */
  async handleContentUpdate(socket, workspaceId, noteId, content) {
    const startTime = Date.now();
    
    try {
      // Verificar si hay usuarios en la nota
      if (noteUsers.has(noteId)) {
        logger.info({
          socketId: socket.id,
          workspaceId,
          noteId,
          contentLength: content.length
        }, 'Actualizando contenido de nota');
        
        // Guardar el nuevo contenido en memoria local
        noteContents.set(noteId, content);
        
        // Guardar en Redis con TTL de 7 días (604800 segundos)
        // Esto permite que el contenido persista incluso si se reinicia el servidor
        const redisKey = `${this.REDIS_PREFIX}${workspaceId}:${noteId}:content`;
        await redisService.set(redisKey, content, 604800);
        
        // Emitir actualización a todos los usuarios en la nota excepto al remitente
        const roomName = `note:${workspaceId}:${noteId}`;
        socket.to(roomName).emit('note_content_updated', {
          noteId,
          content,
          updatedBy: socket.id
        });
        
        metricsService.messageProcessed('note_content_update', Date.now() - startTime);
        
        logger.info({
          socketId: socket.id,
          workspaceId,
          noteId
        }, 'Contenido de nota actualizado correctamente');
      }
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId,
        noteId
      }, 'Error al actualizar contenido de nota');
      
      metricsService.errorOccurred('note_content_update', { 
        socketId: socket.id, 
        workspaceId,
        noteId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al actualizar contenido', details: error.message });
    }
  }

  /**
   * Maneja la desconexión de un usuario
   * @param {Object} socket - Socket de conexión
   */
  handleDisconnect(socket) {
    try {
      // Buscar en qué notas estaba el usuario
      noteUsers.forEach((users, noteId) => {
        const userIndex = users.findIndex(u => u.id === socket.id);
        
        if (userIndex >= 0) {
          // Llamar a handleLeaveNote para cada nota
          // Como no tenemos el workspaceId en este contexto, usamos un valor genérico
          // Esto podría mejorarse almacenando el workspaceId junto con los datos del usuario
          const workspaceId = "unknown";
          this.handleLeaveNote(socket, workspaceId, noteId);
        }
      });
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al manejar desconexión de notas');
    }
  }
}

module.exports = NoteHandler;
