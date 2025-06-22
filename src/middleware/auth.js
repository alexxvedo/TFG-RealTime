const jwt = require('jsonwebtoken');
const config = require('../config/config');
const logger = require('../utils/logger');
const redisService = require('../services/redis');

// Almacenamiento para rate limiting
const rateLimitMap = new Map(); // IP -> {count, lastReset}
const MAX_CONNECTIONS_PER_MINUTE = 60; // Máximo de conexiones por minuto por IP
const RATE_LIMIT_WINDOW = 60 * 1000; // Ventana de 1 minuto

/**
 * Comprueba si una IP ha excedido el límite de conexiones
 * @param {string} ip - Dirección IP
 * @returns {boolean} - true si ha excedido el límite
 */
const checkRateLimit = (ip) => {
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, lastReset: now });
    return false;
  }
  
  const data = rateLimitMap.get(ip);
  
  // Reiniciar contador si ha pasado la ventana de tiempo
  if (now - data.lastReset > RATE_LIMIT_WINDOW) {
    data.count = 1;
    data.lastReset = now;
    rateLimitMap.set(ip, data);
    return false;
  }
  
  // Incrementar contador
  data.count++;
  rateLimitMap.set(ip, data);
  
  // Comprobar si ha excedido el límite
  return data.count > MAX_CONNECTIONS_PER_MINUTE;
};

/**
 * Verifica si un token está en la lista negra
 * @param {string} token - Token JWT
 * @returns {Promise<boolean>} - true si está en la lista negra
 */
const isTokenBlacklisted = async (token) => {
  try {
    const blacklisted = await redisService.get(`blacklist:${token}`);
    return !!blacklisted;
  } catch (error) {
    logger.error({ error: error.message }, 'Error al verificar lista negra de tokens');
    return false; // En caso de error, permitir la conexión
  }
};

/**
 * Middleware para verificar tokens JWT en las conexiones WebSocket
 * @param {Object} socket - Socket de conexión
 * @param {Function} next - Función para continuar con la conexión
 */
const authenticateSocket = async (socket, next) => {
  try {
    // Obtener IP del cliente
    const clientIp = socket.handshake.headers['x-forwarded-for'] || 
                    socket.handshake.address;
    
    // Comprobar rate limiting
    if (checkRateLimit(clientIp)) {
      logger.warn({ ip: clientIp, socketId: socket.id }, 'Rate limit excedido');
      return next(new Error('Demasiadas conexiones. Intente más tarde.'));
    }
    
    // Obtener token del handshake
    const token = socket.handshake.auth.token || 
                 socket.handshake.headers.authorization?.split(' ')[1];
    
    if (!token) {
      logger.warn({ socketId: socket.id, ip: clientIp }, 'Intento de conexión sin token');
      return next(new Error('Autenticación requerida'));
    }
    
    // Verificar si el token está en la lista negra
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      logger.warn({ socketId: socket.id, ip: clientIp }, 'Intento de uso de token revocado');
      return next(new Error('Token revocado'));
    }

    // Verificar token
    const decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'], // Especificar algoritmos permitidos
      maxAge: '1h' // Verificar que el token no haya expirado
    });
    
    // Validar datos requeridos en el token
    if (!decoded.id || !decoded.email) {
      logger.warn({ socketId: socket.id, ip: clientIp }, 'Token con datos incompletos');
      return next(new Error('Token inválido'));
    }
    
    // Guardar información del usuario y metadatos en el objeto socket
    socket.user = decoded;
    socket.connectedAt = new Date();
    socket.clientIp = clientIp;
    
    logger.info({ 
      userId: decoded.id, 
      email: decoded.email, 
      socketId: socket.id,
      ip: clientIp,
      userAgent: socket.handshake.headers['user-agent']
    }, 'Usuario autenticado');
    
    next();
  } catch (error) {
    // Manejar tipos específicos de errores
    if (error.name === 'TokenExpiredError') {
      logger.warn({ socketId: socket.id, error: 'Token expirado' }, 'Error de autenticación');
      return next(new Error('Token expirado'));
    } else if (error.name === 'JsonWebTokenError') {
      logger.warn({ socketId: socket.id, error: error.message }, 'Error de autenticación');
      return next(new Error('Token inválido'));
    }
    
    logger.error({ error: error.message, socketId: socket.id }, 'Error de autenticación');
    next(new Error('Error de autenticación'));
  }
};

/**
 * Añade un token a la lista negra
 * @param {string} token - Token JWT a revocar
 * @param {number} expiry - Tiempo de expiración en segundos
 * @returns {Promise<boolean>} - true si se añadió correctamente
 */
const blacklistToken = async (token, expiry = 3600) => {
  try {
    // Decodificar el token sin verificar para obtener la fecha de expiración
    const decoded = jwt.decode(token);
    
    // Si el token tiene fecha de expiración, usar esa para la lista negra
    const ttl = decoded && decoded.exp ? 
      Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : 
      expiry;
    
    await redisService.set(`blacklist:${token}`, true, ttl);
    return true;
  } catch (error) {
    logger.error({ error: error.message }, 'Error al añadir token a la lista negra');
    return false;
  }
};

// Limpiar el mapa de rate limiting periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.lastReset > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW * 5);

module.exports = {
  authenticateSocket,
  blacklistToken
};
