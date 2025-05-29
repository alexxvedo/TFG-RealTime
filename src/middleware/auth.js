const jwt = require('jsonwebtoken');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Middleware para verificar tokens JWT en las conexiones WebSocket
 * @param {Object} socket - Socket de conexión
 * @param {Function} next - Función para continuar con la conexión
 */
const authenticateSocket = (socket, next) => {
  try {
    // Obtener token del handshake
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    
    if (!token) {
      logger.warn({ socketId: socket.id }, 'Intento de conexión sin token');
      return next(new Error('Autenticación requerida'));
    }

    // Verificar token
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // Guardar información del usuario en el objeto socket
    socket.user = decoded;
    logger.info({ userId: decoded.id, email: decoded.email, socketId: socket.id }, 'Usuario autenticado');
    
    next();
  } catch (error) {
    logger.error({ error: error.message, socketId: socket.id }, 'Error de autenticación');
    next(new Error('Token inválido'));
  }
};

module.exports = {
  authenticateSocket
};
