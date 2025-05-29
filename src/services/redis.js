const { createClient } = require('redis');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Servicio para gestionar la conexión y operaciones con Redis
 * Permite escalabilidad horizontal al compartir estado entre múltiples instancias
 */
class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000; // ms
  }

  /**
   * Inicializa la conexión a Redis
   */
  async initialize() {
    try {
      this.client = createClient({
        socket: {
          host: config.redis.host,
          port: config.redis.port
        }
      });

      // Manejar eventos de conexión
      this.client.on('connect', () => {
        logger.info('Conectando a Redis...');
      });

      this.client.on('ready', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.info({ host: config.redis.host, port: config.redis.port }, 'Conexión a Redis establecida');
      });

      this.client.on('error', (err) => {
        logger.error({ error: err.message }, 'Error en la conexión a Redis');
        this.isConnected = false;
      });

      this.client.on('end', () => {
        this.isConnected = false;
        logger.warn('Conexión a Redis cerrada');
        this._handleReconnect();
      });

      // Conectar al servidor Redis
      await this.client.connect();
    } catch (error) {
      logger.error({ error: error.message }, 'Error al inicializar Redis');
      this._handleReconnect();
    }
  }

  /**
   * Maneja la reconexión automática a Redis
   * @private
   */
  _handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      
      logger.info({ 
        attempt: this.reconnectAttempts, 
        maxAttempts: this.maxReconnectAttempts,
        delay 
      }, 'Intentando reconexión a Redis');
      
      setTimeout(() => this.initialize(), delay);
    } else {
      logger.error('Número máximo de intentos de reconexión a Redis alcanzado');
    }
  }

  /**
   * Guarda un valor en Redis
   * @param {string} key - Clave
   * @param {*} value - Valor a guardar
   * @param {number} [ttl] - Tiempo de vida en segundos (opcional)
   */
  async set(key, value, ttl = null) {
    if (!this.isConnected) {
      logger.warn({ key }, 'Intento de escritura en Redis sin conexión');
      return false;
    }

    try {
      const serializedValue = typeof value === 'object' ? JSON.stringify(value) : value;
      
      if (ttl) {
        await this.client.set(key, serializedValue, { EX: ttl });
      } else {
        await this.client.set(key, serializedValue);
      }
      
      return true;
    } catch (error) {
      logger.error({ error: error.message, key }, 'Error al guardar en Redis');
      return false;
    }
  }

  /**
   * Obtiene un valor de Redis
   * @param {string} key - Clave a buscar
   * @param {boolean} [parse=true] - Si debe intentar parsear como JSON
   * @returns {*} Valor almacenado o null si no existe
   */
  async get(key, parse = true) {
    if (!this.isConnected) {
      logger.warn({ key }, 'Intento de lectura de Redis sin conexión');
      return null;
    }

    try {
      const value = await this.client.get(key);
      
      if (!value) return null;
      
      if (parse) {
        try {
          return JSON.parse(value);
        } catch (e) {
          return value;
        }
      }
      
      return value;
    } catch (error) {
      logger.error({ error: error.message, key }, 'Error al leer de Redis');
      return null;
    }
  }

  /**
   * Elimina una clave de Redis
   * @param {string} key - Clave a eliminar
   */
  async delete(key) {
    if (!this.isConnected) {
      logger.warn({ key }, 'Intento de eliminación en Redis sin conexión');
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error({ error: error.message, key }, 'Error al eliminar de Redis');
      return false;
    }
  }

  /**
   * Publica un mensaje en un canal de Redis
   * @param {string} channel - Canal donde publicar
   * @param {*} message - Mensaje a publicar
   */
  async publish(channel, message) {
    if (!this.isConnected) {
      logger.warn({ channel }, 'Intento de publicación en Redis sin conexión');
      return false;
    }

    try {
      const serializedMessage = typeof message === 'object' ? JSON.stringify(message) : message;
      await this.client.publish(channel, serializedMessage);
      return true;
    } catch (error) {
      logger.error({ error: error.message, channel }, 'Error al publicar en Redis');
      return false;
    }
  }

  /**
   * Suscribe a un canal de Redis
   * @param {string} channel - Canal a suscribirse
   * @param {Function} callback - Función a llamar cuando llegue un mensaje
   */
  async subscribe(channel, callback) {
    if (!this.isConnected) {
      logger.warn({ channel }, 'Intento de suscripción a Redis sin conexión');
      return false;
    }

    try {
      const subscriber = this.client.duplicate();
      await subscriber.connect();
      
      await subscriber.subscribe(channel, (message) => {
        try {
          const parsedMessage = JSON.parse(message);
          callback(parsedMessage);
        } catch (e) {
          callback(message);
        }
      });
      
      logger.info({ channel }, 'Suscripción a canal de Redis establecida');
      return true;
    } catch (error) {
      logger.error({ error: error.message, channel }, 'Error al suscribirse a canal de Redis');
      return false;
    }
  }

  /**
   * Cierra la conexión a Redis
   */
  async close() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        logger.info('Conexión a Redis cerrada correctamente');
      } catch (error) {
        logger.error({ error: error.message }, 'Error al cerrar conexión a Redis');
      }
    }
  }
}

// Singleton para usar en toda la aplicación
const redisService = new RedisService();

module.exports = redisService;
