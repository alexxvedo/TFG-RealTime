const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const compression = require('compression');
const path = require('path');
const config = require('./config/config');
const logger = require('./utils/logger');
const { authenticateSocket } = require('./middleware/auth');
const redisService = require('./services/redis');
const metricsService = require('./services/metrics');

// Importar handlers de módulos
const WorkspaceHandler = require('./modules/workspace/workspace.handler');
const CollectionHandler = require('./modules/collection/collection.handler');
const ChatHandler = require('./modules/chat/chat.handler');
const NoteHandler = require('./modules/note/note.handler');

// Crear aplicación Express
const app = express();

// Usar compresión para todas las respuestas
app.use(compression());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

// Crear servidor HTTP
const server = http.createServer(app);

// Configurar Socket.IO
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  // Configurar compresión de mensajes
  perMessageDeflate: {
    threshold: 1024, // Comprimir mensajes mayores a 1KB
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    }
  }
});

// Ruta para monitoreo de estado
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Ruta para métricas (protegida en producción)
app.get('/metrics', (req, res) => {
  if (config.environment === 'production') {
    // En producción, esta ruta debería estar protegida
    // Aquí se podría implementar autenticación
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.METRICS_API_KEY}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  
  const metrics = metricsService.getMetricsSummary();
  res.status(200).json(metrics);
});

// Inicializar el servicio Redis
(async () => {
  try {
    await redisService.initialize();
    logger.info('Servicio Redis inicializado correctamente');
  } catch (error) {
    logger.error({ error: error.message }, 'Error al inicializar Redis');
  }
})();

// Middleware para autenticación de sockets
// En desarrollo, se puede omitir la autenticación para facilitar las pruebas
if (config.environment === 'production') {
  io.use(authenticateSocket);
} else {
  // En desarrollo, simular autenticación
  io.use((socket, next) => {
    // Extraer token del handshake si existe
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    
    // Si hay token, intentar verificarlo
    if (token) {
      try {
        // En un entorno real, aquí verificaríamos el token
        // Para desarrollo, simplemente extraemos la información del usuario
        const [userId, email, name] = token.split('.');
        socket.user = { id: userId, email, name };
      } catch (error) {
        logger.warn({ error: error.message }, 'Error al verificar token en desarrollo');
      }
    }
    
    // En desarrollo, permitir conexión incluso sin token
    next();
  });
}

// Crear instancias de handlers
const workspaceHandler = new WorkspaceHandler(io);
const collectionHandler = new CollectionHandler(io);
const chatHandler = new ChatHandler(io);
const noteHandler = new NoteHandler(io);

// Manejar conexiones de sockets
io.on('connection', (socket) => {
  const startTime = Date.now();
  
  logger.info({
    socketId: socket.id,
    userId: socket.user?.id,
    userAgent: socket.handshake.headers['user-agent']
  }, 'Nueva conexión de socket');
  
  // Registrar métricas de conexión
  metricsService.connectionCreated(socket.id, socket.user);
  
  // Registrar handlers para cada módulo
  workspaceHandler.registerHandlers(socket);
  collectionHandler.registerHandlers(socket);
  chatHandler.registerHandlers(socket);
  noteHandler.registerHandlers(socket);
  
  // Manejar desconexión
  socket.on('disconnect', () => {
    logger.info({
      socketId: socket.id,
      userId: socket.user?.id,
      duration: `${(Date.now() - startTime) / 1000}s`
    }, 'Socket desconectado');
    
    // Notificar a todos los handlers
    workspaceHandler.handleDisconnect(socket);
    collectionHandler.handleDisconnect(socket);
    chatHandler.handleDisconnect(socket);
    noteHandler.handleDisconnect(socket);
    
    // Registrar métricas de desconexión
    metricsService.connectionClosed(socket.id);
  });
  
  // Manejar errores
  socket.on('error', (error) => {
    logger.error({
      error: error.message,
      socketId: socket.id,
      userId: socket.user?.id
    }, 'Error en socket');
    
    metricsService.errorOccurred('socket_error', {
      socketId: socket.id,
      error: error.message
    });
  });
});

// Manejar errores del servidor
process.on('uncaughtException', (error) => {
  logger.fatal({
    error: error.message,
    stack: error.stack
  }, 'Error no capturado en el servidor');
  
  // En producción, podríamos querer reiniciar el proceso
  if (config.environment === 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    reason: reason.toString(),
    stack: reason.stack
  }, 'Promesa rechazada no manejada');
});

// Iniciar servidor
const PORT = config.port;
server.listen(PORT, () => {
  logger.info({
    port: PORT,
    environment: config.environment,
    nodeVersion: process.version
  }, 'Servidor WebSocket iniciado');
  
  console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
  console.log(`Métricas disponibles en http://localhost:${PORT}/metrics`);
});
