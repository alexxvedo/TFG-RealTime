const logger = require('../../utils/logger');
const metricsService = require('../../services/metrics');
const redisService = require('../../services/redis');

// Almacenamiento en memoria (se reemplazará gradualmente por Redis)
const workspaceMessages = new Map(); // workspaceId -> Array<Message>
const typingUsers = new Map(); // workspaceId -> Map(userId -> {name, timestamp})

/**
 * Clase para manejar eventos relacionados con el chat
 */
class ChatHandler {
  /**
   * Inicializa el handler con la instancia de socket.io
   * @param {Object} io - Instancia de Socket.IO
   */
  constructor(io) {
    this.io = io;
    this.REDIS_PREFIX = 'chat:';
    this.MESSAGE_LIMIT = 100; // Número máximo de mensajes a almacenar por workspace
    this.TYPING_TIMEOUT = 5000; // Tiempo en ms para considerar que un usuario dejó de escribir
    
    // Iniciar limpieza periódica de estados de escritura
    this._startTypingCleanup();
  }

  /**
   * Registra todos los manejadores de eventos para el chat
   * @param {Object} socket - Socket de conexión
   */
  registerHandlers(socket) {
    socket.on('new_message', (messageData) => this.handleNewMessage(socket, messageData));
    socket.on('user_typing', (data) => this.handleUserTyping(socket, data));
    socket.on('user_stop_typing', (data) => this.handleUserStopTyping(socket, data));
  }

  /**
   * Maneja el evento de nuevo mensaje
   * @param {Object} socket - Socket de conexión
   * @param {Object} messageData - Datos del mensaje
   */
  async handleNewMessage(socket, messageData) {
    const startTime = Date.now();
    
    try {
      const { workspaceId, senderEmail, senderName, senderImage, content } = messageData;
      
      if (!workspaceId || !content || !senderEmail) {
        logger.warn({
          socketId: socket.id,
          messageData
        }, 'Mensaje inválido recibido');
        
        socket.emit('error', { message: 'Datos de mensaje incompletos' });
        return;
      }
      
      logger.info({
        socketId: socket.id,
        workspaceId,
        senderEmail,
        contentLength: content.length
      }, 'Nuevo mensaje recibido');

      // Crear objeto de mensaje
      const newMessage = {
        id: Date.now().toString(),
        workspaceId,
        senderEmail,
        senderName,
        senderImage,
        content,
        timestamp: new Date().toISOString()
      };
      
      // Guardar mensaje en memoria local
      if (!workspaceMessages.has(workspaceId)) {
        workspaceMessages.set(workspaceId, []);
      }
      workspaceMessages.get(workspaceId).push(newMessage);
      
      // Limitar la cantidad de mensajes almacenados
      const messages = workspaceMessages.get(workspaceId);
      if (messages.length > this.MESSAGE_LIMIT) {
        workspaceMessages.set(workspaceId, messages.slice(-this.MESSAGE_LIMIT));
      }
      
      // Guardar mensaje en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:messages`;
      const redisMessages = await redisService.get(redisKey) || [];
      redisMessages.push(newMessage);
      
      // Limitar la cantidad de mensajes en Redis
      if (redisMessages.length > this.MESSAGE_LIMIT) {
        redisMessages.splice(0, redisMessages.length - this.MESSAGE_LIMIT);
      }
      
      await redisService.set(redisKey, redisMessages);
      
      // Comprimir el mensaje antes de enviarlo (implementación de compresión de mensajes)
      const compressedMessage = this._compressMessage(newMessage);
      
      // Emitir mensaje a todos los usuarios en el workspace
      this.io.to(workspaceId).emit('new_message', compressedMessage);
      
      // Limpiar estado de "escribiendo" para el usuario que envió el mensaje
      this.handleUserStopTyping(socket, { workspaceId, email: senderEmail, name: senderName });
      
      metricsService.messageProcessed('new_message', Date.now() - startTime);
      
      logger.info({
        socketId: socket.id,
        messageId: newMessage.id,
        workspaceId,
        senderEmail
      }, 'Mensaje enviado correctamente');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al procesar nuevo mensaje');
      
      metricsService.errorOccurred('new_message', { 
        socketId: socket.id, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al enviar mensaje', details: error.message });
    }
  }

  /**
   * Maneja el evento de usuario escribiendo
   * @param {Object} socket - Socket de conexión
   * @param {Object} data - Datos del evento
   */
  async handleUserTyping(socket, data) {
    try {
      const { workspaceId, email, name } = data;
      
      if (!workspaceId || !email) return;
      
      logger.debug({
        socketId: socket.id,
        workspaceId,
        email
      }, 'Usuario escribiendo');
      
      // Actualizar estado en memoria local
      if (!typingUsers.has(workspaceId)) {
        typingUsers.set(workspaceId, new Map());
      }
      
      const workspaceTypingUsers = typingUsers.get(workspaceId);
      workspaceTypingUsers.set(email, { name, timestamp: Date.now() });
      
      // Actualizar estado en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:typing`;
      const redisTypingUsers = await redisService.get(redisKey) || {};
      redisTypingUsers[email] = { name, timestamp: Date.now() };
      await redisService.set(redisKey, redisTypingUsers, 10); // TTL de 10 segundos
      
      // Notificar a todos los usuarios del workspace
      this.io.to(workspaceId).emit('user_typing', { email, name });
      
      metricsService.messageProcessed('user_typing');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al procesar evento de usuario escribiendo');
      
      metricsService.errorOccurred('user_typing', { 
        socketId: socket.id, 
        error: error.message 
      });
    }
  }

  /**
   * Maneja el evento de usuario que deja de escribir
   * @param {Object} socket - Socket de conexión
   * @param {Object} data - Datos del evento
   */
  async handleUserStopTyping(socket, data) {
    try {
      const { workspaceId, email, name } = data;
      
      if (!workspaceId || !email) return;
      
      logger.debug({
        socketId: socket.id,
        workspaceId,
        email
      }, 'Usuario dejó de escribir');
      
      // Actualizar estado en memoria local
      if (typingUsers.has(workspaceId)) {
        const workspaceTypingUsers = typingUsers.get(workspaceId);
        workspaceTypingUsers.delete(email);
      }
      
      // Actualizar estado en Redis
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:typing`;
      const redisTypingUsers = await redisService.get(redisKey) || {};
      delete redisTypingUsers[email];
      await redisService.set(redisKey, redisTypingUsers, 10); // TTL de 10 segundos
      
      // Notificar a todos los usuarios del workspace
      this.io.to(workspaceId).emit('user_stop_typing', { email, name });
      
      metricsService.messageProcessed('user_stop_typing');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al procesar evento de usuario que deja de escribir');
      
      metricsService.errorOccurred('user_stop_typing', { 
        socketId: socket.id, 
        error: error.message 
      });
    }
  }

  /**
   * Inicia la limpieza periódica de estados de escritura
   * @private
   */
  _startTypingCleanup() {
    setInterval(async () => {
      const now = Date.now();
      
      // Limpiar estados de escritura en memoria local
      typingUsers.forEach((workspaceTypingUsers, workspaceId) => {
        workspaceTypingUsers.forEach((userData, email) => {
          if (now - userData.timestamp > this.TYPING_TIMEOUT) {
            workspaceTypingUsers.delete(email);
            this.io.to(workspaceId).emit('user_stop_typing', { 
              email, 
              name: userData.name 
            });
          }
        });
      });
      
      // No es necesario limpiar en Redis porque usamos TTL
    }, this.TYPING_TIMEOUT);
  }

  /**
   * Comprime un mensaje para reducir el tamaño del payload
   * @param {Object} message - Mensaje original
   * @returns {Object} Mensaje comprimido
   * @private
   */
  _compressMessage(message) {
    // Implementación simple de compresión de mensajes
    // En una implementación real, se podría usar una biblioteca de compresión
    // o estrategias más avanzadas como enviar solo los campos necesarios
    
    const compressed = {
      i: message.id,
      w: message.workspaceId,
      e: message.senderEmail,
      n: message.senderName,
      // Solo incluir imagen si existe y no es una URL muy larga
      ...(message.senderImage && message.senderImage.length < 200 && { img: message.senderImage }),
      c: message.content,
      t: message.timestamp
    };
    
    return compressed;
  }

  /**
   * Obtiene el historial de mensajes de un workspace
   * @param {Object} socket - Socket de conexión
   * @param {string} workspaceId - ID del workspace
   */
  async getMessageHistory(socket, workspaceId) {
    try {
      logger.info({
        socketId: socket.id,
        workspaceId
      }, 'Solicitando historial de mensajes');
      
      // Intentar obtener mensajes de Redis primero
      const redisKey = `${this.REDIS_PREFIX}${workspaceId}:messages`;
      let messages = await redisService.get(redisKey);
      
      // Si no hay mensajes en Redis, usar memoria local
      if (!messages || messages.length === 0) {
        messages = workspaceMessages.get(workspaceId) || [];
      }
      
      // Comprimir mensajes antes de enviarlos
      const compressedMessages = messages.map(msg => this._compressMessage(msg));
      
      socket.emit('message_history', compressedMessages);
      
      logger.info({
        socketId: socket.id,
        workspaceId,
        messageCount: messages.length
      }, 'Historial de mensajes enviado');
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id,
        workspaceId
      }, 'Error al obtener historial de mensajes');
      
      metricsService.errorOccurred('get_message_history', { 
        socketId: socket.id, 
        workspaceId, 
        error: error.message 
      });
      
      socket.emit('error', { message: 'Error al obtener historial de mensajes', details: error.message });
    }
  }

  /**
   * Maneja la desconexión de un usuario
   * @param {Object} socket - Socket de conexión
   */
  handleDisconnect(socket) {
    try {
      // Limpiar estados de escritura
      typingUsers.forEach((workspaceTypingUsers, workspaceId) => {
        // Buscar el email del usuario por su socket.id
        // Esto requiere que tengamos acceso a los datos del usuario
        // que normalmente estarían en workspaceSockets
        if (socket.user) {
          const email = socket.user.email;
          if (workspaceTypingUsers.has(email)) {
            const userData = workspaceTypingUsers.get(email);
            workspaceTypingUsers.delete(email);
            
            this.io.to(workspaceId).emit('user_stop_typing', { 
              email, 
              name: userData.name 
            });
          }
        }
      });
    } catch (error) {
      logger.error({
        error: error.message,
        socketId: socket.id
      }, 'Error al manejar desconexión de chat');
    }
  }
}

module.exports = ChatHandler;
