const pino = require('pino');
const config = require('../config/config');

// Configuración para desarrollo con formato legible
const devConfig = {
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  },
  level: config.logging.level
};

// Configuración para producción con formato JSON
const prodConfig = {
  level: config.logging.level
};

// Seleccionar configuración según el entorno
const loggerConfig = config.environment === 'production' ? prodConfig : devConfig;

// Crear instancia del logger
const logger = pino(loggerConfig);

module.exports = logger;
