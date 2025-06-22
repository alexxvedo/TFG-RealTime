const { createClient } = require("redis");
const config = require("../config/config");
const logger = require("../utils/logger");

/**
 * Servicio para gestionar la conexión y operaciones con Redis
 * Permite escalabilidad horizontal al compartir estado entre múltiples instancias
 * Incluye caché local, circuit breaker, y operaciones por lotes para mayor eficiencia y resiliencia
 */
class RedisService {
  constructor() {
    // Configuración básica
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000; // ms

    // Caché local
    this.localCache = new Map();
    this.cacheEnabled = true;
    this.cacheTTL = 60 * 1000; // 1 minuto en milisegundos
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Circuit breaker
    this.circuitOpen = false;
    this.circuitResetTime = 0;
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.resetTimeout = 30000; // 30 segundos

    // Iniciar limpieza periódica de caché
    setInterval(() => this._cleanupCache(), 60000); // Limpiar cada minuto
  }

  /**
   * Inicializa la conexión a Redis
   */
  async initialize() {
    try {
      // Si el circuit breaker está abierto, no intentar reconectar
      if (this.circuitOpen) {
        const now = Date.now();
        if (now < this.circuitResetTime) {
          logger.warn(
            {
              resetTime: new Date(this.circuitResetTime).toISOString(),
            },
            "Circuit breaker abierto, no se intentará conectar a Redis"
          );
          return false;
        } else {
          // Cerrar el circuit breaker e intentar de nuevo
          this.circuitOpen = false;
          this.failureCount = 0;
          logger.info("Circuit breaker cerrado, intentando conexión a Redis");
        }
      }

      this.client = createClient({
        socket: {
          host: config.redis.host,
          port: config.redis.port,
          reconnectStrategy: (retries) => {
            // Dejar que nuestro sistema maneje la reconexión
            return false;
          },
        },
      });

      // Manejar eventos de conexión
      this.client.on("connect", () => {
        logger.info("Conectando a Redis...");
      });

      this.client.on("ready", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.failureCount = 0;
        this.circuitOpen = false;
        logger.info(
          { host: config.redis.host, port: config.redis.port },
          "Conexión a Redis establecida"
        );
      });

      this.client.on("error", (err) => {
        logger.error({ error: err.message }, "Error en la conexión a Redis");
        this.isConnected = false;
        this._handleFailure();
      });

      this.client.on("end", () => {
        this.isConnected = false;
        logger.warn("Conexión a Redis cerrada");
        this._handleReconnect();
      });

      // Conectar al servidor Redis
      await this.client.connect();
      return true;
    } catch (error) {
      logger.error({ error: error.message }, "Error al inicializar Redis");
      this._handleFailure();
      this._handleReconnect();
      return false;
    }
  }

  /**
   * Maneja la reconexión automática a Redis con backoff exponencial y jitter
   * @private
   */
  _handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;

      // Backoff exponencial con jitter
      const baseDelay =
        this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      const jitter = Math.random() * 0.3 * baseDelay; // 30% de jitter
      const delay = baseDelay + jitter;

      logger.info(
        {
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts,
          delay: Math.round(delay),
        },
        "Intentando reconexión a Redis"
      );

      setTimeout(() => this.initialize(), delay);
    } else {
      logger.error("Número máximo de intentos de reconexión a Redis alcanzado");
      // Abrir el circuit breaker
      this.circuitOpen = true;
      this.circuitResetTime = Date.now() + 60 * 1000; // 1 minuto

      // Programar un intento de reconexión después de un tiempo más largo
      setTimeout(() => {
        this.reconnectAttempts = 0;
        this.initialize();
      }, 5 * 60 * 1000); // 5 minutos
    }
  }

  /**
   * Maneja un fallo en la operación de Redis y actualiza el circuit breaker
   * @private
   */
  _handleFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.circuitOpen = true;
      this.circuitResetTime = Date.now() + this.resetTimeout;
      logger.warn(
        {
          failureCount: this.failureCount,
          resetTime: new Date(this.circuitResetTime).toISOString(),
        },
        "Circuit breaker abierto para Redis"
      );
    }
  }

  /**
   * Comprueba si el circuit breaker permite operaciones
   * @private
   * @returns {boolean} - true si se pueden realizar operaciones, false si no
   */
  _checkCircuitBreaker() {
    if (this.circuitOpen) {
      const now = Date.now();
      if (now > this.circuitResetTime) {
        // Intentar cerrar el circuito
        this.circuitOpen = false;
        this.failureCount = 0;
        logger.info(
          "Circuit breaker cerrado, intentando operaciones de Redis nuevamente"
        );
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Limpia las entradas expiradas de la caché local
   * @private
   */
  _cleanupCache() {
    if (!this.cacheEnabled || this.localCache.size === 0) return;

    const now = Date.now();
    let expiredCount = 0;

    for (const [key, cached] of this.localCache.entries()) {
      if (cached.expiry < now) {
        this.localCache.delete(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logger.debug(
        { expiredCount, remaining: this.localCache.size },
        "Limpieza de caché completada"
      );
    }
  }

  /**
   * Guarda un valor en Redis
   * @param {string} key - Clave
   * @param {*} value - Valor a guardar
   * @param {number} [ttl] - Tiempo de vida en segundos (opcional)
   * @returns {Promise<boolean>} - true si se guardó correctamente, false si no
   */
  async set(key, value, ttl = null) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { key, circuitOpen: this.circuitOpen },
        "Intento de escritura en Redis bloqueado"
      );
      return false;
    }

    try {
      const serializedValue =
        typeof value === "object" ? JSON.stringify(value) : value;

      if (ttl) {
        await this.client.set(key, serializedValue, { EX: ttl });
      } else {
        await this.client.set(key, serializedValue);
      }

      // Actualizar caché local
      if (this.cacheEnabled) {
        this.localCache.set(key, {
          value,
          expiry: Date.now() + this.cacheTTL,
        });
      }

      return true;
    } catch (error) {
      this._handleFailure();
      logger.error({ error: error.message, key }, "Error al guardar en Redis");
      return false;
    }
  }

  /**
   * Obtiene un valor de Redis con soporte de caché local
   * @param {string} key - Clave a buscar
   * @param {boolean} [parse=true] - Si debe intentar parsear como JSON
   * @param {boolean} [bypassCache=false] - Si debe ignorar la caché local
   * @returns {Promise<*>} Valor almacenado o null si no existe
   */
  async get(key, parse = true, bypassCache = false) {
    // Comprobar caché local primero si está habilitada y no se solicita bypass
    if (this.cacheEnabled && !bypassCache) {
      const cached = this.localCache.get(key);
      if (cached && cached.expiry > Date.now()) {
        this.cacheHits++;
        return cached.value;
      }
      this.cacheMisses++;
    }

    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { key, circuitOpen: this.circuitOpen },
        "Intento de lectura de Redis bloqueado"
      );
      return null;
    }

    try {
      const value = await this.client.get(key);

      if (!value) return null;

      let result = value;
      if (parse) {
        try {
          result = JSON.parse(value);
        } catch (e) {
          result = value;
        }
      }

      // Guardar en caché local
      if (this.cacheEnabled) {
        this.localCache.set(key, {
          value: result,
          expiry: Date.now() + this.cacheTTL,
        });
      }

      return result;
    } catch (error) {
      this._handleFailure();
      logger.error({ error: error.message, key }, "Error al leer de Redis");
      return null;
    }
  }

  /**
   * Elimina una clave de Redis y de la caché local
   * @param {string} key - Clave a eliminar
   * @returns {Promise<boolean>} - true si se eliminó correctamente, false si no
   */
  async delete(key) {
    // Eliminar de la caché local primero
    if (this.cacheEnabled) {
      this.localCache.delete(key);
    }

    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { key, circuitOpen: this.circuitOpen },
        "Intento de eliminación en Redis bloqueado"
      );
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      this._handleFailure();
      logger.error({ error: error.message, key }, "Error al eliminar de Redis");
      return false;
    }
  }

  /**
   * Publica un mensaje en un canal de Redis
   * @param {string} channel - Canal donde publicar
   * @param {*} message - Mensaje a publicar
   * @returns {Promise<boolean>} - true si se publicó correctamente, false si no
   */
  async publish(channel, message) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { channel, circuitOpen: this.circuitOpen },
        "Intento de publicación en Redis bloqueado"
      );
      return false;
    }

    try {
      const serializedMessage =
        typeof message === "object" ? JSON.stringify(message) : message;
      await this.client.publish(channel, serializedMessage);
      return true;
    } catch (error) {
      this._handleFailure();
      logger.error(
        { error: error.message, channel },
        "Error al publicar en Redis"
      );
      return false;
    }
  }

  /**
   * Suscribe a un canal de Redis
   * @param {string} channel - Canal a suscribirse
   * @param {Function} callback - Función a llamar cuando llegue un mensaje
   * @returns {Promise<boolean>} - true si se suscribió correctamente, false si no
   */
  async subscribe(channel, callback) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { channel, circuitOpen: this.circuitOpen },
        "Intento de suscripción a Redis bloqueado"
      );
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

      logger.info({ channel }, "Suscripción a canal de Redis establecida");
      return true;
    } catch (error) {
      this._handleFailure();
      logger.error(
        { error: error.message, channel },
        "Error al suscribirse a canal de Redis"
      );
      return false;
    }
  }

  /**
   * Obtiene múltiples valores de Redis en una sola operación
   * @param {string[]} keys - Array de claves a obtener
   * @returns {Promise<Array>} - Array de valores (null para las claves que no existen)
   */
  async mget(keys) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { keysCount: keys.length, circuitOpen: this.circuitOpen },
        "Intento de mget en Redis bloqueado"
      );
      return keys.map(() => null);
    }

    try {
      // Comprobar caché local primero
      const results = [];
      const missingKeys = [];
      const missingIndexes = [];

      if (this.cacheEnabled) {
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const cached = this.localCache.get(key);

          if (cached && cached.expiry > Date.now()) {
            results[i] = cached.value;
            this.cacheHits++;
          } else {
            results[i] = null;
            missingKeys.push(key);
            missingIndexes.push(i);
            this.cacheMisses++;
          }
        }
      } else {
        // Si la caché está deshabilitada, obtener todos de Redis
        missingKeys.push(...keys);
        missingIndexes.push(...keys.map((_, i) => i));
        results.length = keys.length;
        results.fill(null);
      }

      // Si hay claves que no están en caché, obtenerlas de Redis
      if (missingKeys.length > 0) {
        const values = await this.client.mGet(missingKeys);

        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          const index = missingIndexes[i];
          const key = missingKeys[i];

          if (!value) continue;

          try {
            const parsed = JSON.parse(value);
            results[index] = parsed;

            // Actualizar caché
            if (this.cacheEnabled) {
              this.localCache.set(key, {
                value: parsed,
                expiry: Date.now() + this.cacheTTL,
              });
            }
          } catch (e) {
            results[index] = value;

            // Actualizar caché
            if (this.cacheEnabled) {
              this.localCache.set(key, {
                value,
                expiry: Date.now() + this.cacheTTL,
              });
            }
          }
        }
      }

      return results;
    } catch (error) {
      this._handleFailure();
      logger.error({ error: error.message }, "Error en mget de Redis");
      return keys.map(() => null);
    }
  }

  /**
   * Guarda múltiples valores en Redis en una sola operación
   * @param {Array<Array<string, any>>} entries - Array de pares [clave, valor]
   * @param {number} [ttl] - Tiempo de vida en segundos (opcional)
   * @returns {Promise<boolean>} - true si se guardaron correctamente, false si no
   */
  async mset(entries, ttl = null) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { entriesCount: entries.length, circuitOpen: this.circuitOpen },
        "Intento de mset en Redis bloqueado"
      );
      return false;
    }

    try {
      const pipeline = this.client.multi();

      for (const [key, value] of entries) {
        const serializedValue =
          typeof value === "object" ? JSON.stringify(value) : value;
        if (ttl) {
          pipeline.set(key, serializedValue, { EX: ttl });
        } else {
          pipeline.set(key, serializedValue);
        }

        // Actualizar caché local
        if (this.cacheEnabled) {
          this.localCache.set(key, {
            value,
            expiry: Date.now() + this.cacheTTL,
          });
        }
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      this._handleFailure();
      logger.error({ error: error.message }, "Error en mset de Redis");
      return false;
    }
  }

  /**
   * Incrementa un valor numérico en Redis
   * @param {string} key - Clave a incrementar
   * @param {number} [amount=1] - Cantidad a incrementar
   * @returns {Promise<number|null>} - Nuevo valor o null si hubo error
   */
  async increment(key, amount = 1) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { key, circuitOpen: this.circuitOpen },
        "Intento de incremento en Redis bloqueado"
      );
      return null;
    }

    try {
      const result = await this.client.incrBy(key, amount);

      // Actualizar caché local
      if (this.cacheEnabled) {
        this.localCache.set(key, {
          value: result,
          expiry: Date.now() + this.cacheTTL,
        });
      }

      return result;
    } catch (error) {
      this._handleFailure();
      logger.error(
        { error: error.message, key },
        "Error al incrementar valor en Redis"
      );
      return null;
    }
  }

  /**
   * Establece un tiempo de expiración para una clave
   * @param {string} key - Clave
   * @param {number} seconds - Segundos hasta expiración
   * @returns {Promise<boolean>} - true si se estableció correctamente, false si no
   */
  async expire(key, seconds) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { key, circuitOpen: this.circuitOpen },
        "Intento de establecer expiración en Redis bloqueado"
      );
      return false;
    }

    try {
      return await this.client.expire(key, seconds);
    } catch (error) {
      this._handleFailure();
      logger.error(
        { error: error.message, key },
        "Error al establecer expiración en Redis"
      );
      return false;
    }
  }

  /**
   * Busca claves que coincidan con un patrón
   * @param {string} pattern - Patrón de búsqueda (ej: user:*)
   * @returns {Promise<string[]>} - Array de claves encontradas
   */
  async keys(pattern) {
    if (!this.isConnected || !this._checkCircuitBreaker()) {
      logger.warn(
        { pattern, circuitOpen: this.circuitOpen },
        "Intento de buscar claves en Redis bloqueado"
      );
      return [];
    }

    try {
      return await this.client.keys(pattern);
    } catch (error) {
      this._handleFailure();
      logger.error(
        { error: error.message, pattern },
        "Error al buscar claves en Redis"
      );
      return [];
    }
  }

  /**
   * Obtiene métricas del servicio de Redis
   * @returns {Object} - Objeto con métricas
   */
  /**
   * Realiza un health check de la conexión a Redis
   * @returns {Promise<Object>} - Resultado del health check
   */
  async healthCheck() {
    const startTime = Date.now();
    let status = "healthy";
    let responseTime = 0;
    let error = null;

    try {
      if (!this.isConnected || this.circuitOpen) {
        return {
          status: "unhealthy",
          error: this.circuitOpen ? "Circuit breaker abierto" : "No conectado",
          timestamp: new Date().toISOString(),
          metrics: this.getMetrics()
        };
      }

      // Realizar un ping para comprobar la latencia
      await this.client.ping();
      responseTime = Date.now() - startTime;

      // Si la respuesta tarda demasiado, considerar degradado
      if (responseTime > 100) { // más de 100ms se considera lento
        status = "degraded";
      }
    } catch (err) {
      status = "unhealthy";
      error = err.message;
      this._handleFailure();
    }

    return {
      status,
      responseTime,
      error,
      timestamp: new Date().toISOString(),
      metrics: this.getMetrics()
    };
  }

  /**
   * Configura dinámicamente los parámetros de caché
   * @param {Object} options - Opciones de configuración
   * @param {boolean} [options.enabled] - Activar/desactivar caché
   * @param {number} [options.ttl] - TTL en milisegundos
   * @returns {Object} - Configuración actual
   */
  configureCaching(options = {}) {
    if (typeof options.enabled === 'boolean') {
      this.cacheEnabled = options.enabled;
      
      // Si se desactiva la caché, limpiarla
      if (!this.cacheEnabled) {
        this.localCache.clear();
        logger.info("Caché local desactivada y limpiada");
      } else {
        logger.info("Caché local activada");
      }
    }
    
    if (typeof options.ttl === 'number' && options.ttl > 0) {
      this.cacheTTL = options.ttl;
      logger.info({ ttl: this.cacheTTL }, "TTL de caché actualizado");
    }
    
    return {
      enabled: this.cacheEnabled,
      ttl: this.cacheTTL,
      size: this.localCache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses
    };
  }

  getMetrics() {
    return {
      connected: this.isConnected,
      circuitBreakerStatus: this.circuitOpen ? "open" : "closed",
      reconnectAttempts: this.reconnectAttempts,
      failureCount: this.failureCount,
      cacheEnabled: this.cacheEnabled,
      cacheSize: this.localCache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRatio:
        this.cacheHits + this.cacheMisses > 0
          ? (
              (this.cacheHits / (this.cacheHits + this.cacheMisses)) *
              100
            ).toFixed(2) + "%"
          : "N/A",
      resetTime: this.circuitOpen
        ? new Date(this.circuitResetTime).toISOString()
        : "N/A",
    };
  }

  /**
   * Cierra la conexión a Redis
   */
  async close() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        logger.info("Conexión a Redis cerrada correctamente");
      } catch (error) {
        logger.error(
          { error: error.message },
          "Error al cerrar conexión a Redis"
        );
      }
    }
  }
}

// Singleton para usar en toda la aplicación
const redisService = new RedisService();

module.exports = redisService;
