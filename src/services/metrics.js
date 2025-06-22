const logger = require('../utils/logger');
const redisService = require('./redis');

/**
 * Servicio para recopilar y monitorear métricas del servidor WebSocket
 * con soporte para alertas y optimización de almacenamiento
 */
class MetricsService {
  constructor() {
    this.metrics = {
      connections: {
        total: 0,
        active: 0,
        history: [],
        byUserAgent: new Map(), // userAgent -> count
        byCountry: new Map(), // country -> count (basado en IP)
        peak: {
          count: 0,
          timestamp: null
        }
      },
      messages: {
        total: 0,
        byType: {},
        ratePerMinute: 0,
        lastMinuteCount: 0,
        lastMinuteTimestamp: Date.now()
      },
      workspaces: {
        active: new Map(), // workspaceId -> Set de usuarios
        mostActive: null, // workspaceId con más usuarios
        totalCount: 0
      },
      collections: {
        active: new Map(), // collectionId -> Set de usuarios
        mostActive: null, // collectionId con más usuarios
        totalCount: 0
      },
      errors: {
        count: 0,
        byType: {},
        lastError: null,
        errorRate: 0 // Porcentaje de operaciones con error
      },
      performance: {
        messageLatency: [], // Array de tiempos de procesamiento de mensajes
        averageLatency: 0,
        p95Latency: 0, // Percentil 95 de latencia
        memoryUsage: {
          rss: 0,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
          history: []
        },
        cpuUsage: {
          user: 0,
          system: 0,
          history: []
        }
      },
      alerts: {
        triggered: [], // Alertas activadas recientemente
        thresholds: {
          highLatency: 500, // ms
          highErrorRate: 5, // %
          highMemoryUsage: 80, // %
          connectionSpike: 50, // % de incremento
          inactiveWorkspaces: 7 // días
        }
      }
    };

    // Guardar métricas cada minuto para análisis histórico
    setInterval(() => this.recordHistory(), 60000);
    
    // Actualizar métricas de rendimiento del sistema cada 5 segundos
    setInterval(() => this.updateSystemMetrics(), 5000);
    
    // Comprobar alertas cada minuto
    setInterval(() => this.checkAlerts(), 60000);
    
    // Limpiar datos históricos antiguos cada hora
    setInterval(() => this.cleanupHistoricalData(), 3600000);
  }
  
  /**
   * Actualiza las métricas de rendimiento del sistema
   */
  async updateSystemMetrics() {
    try {
      // Memoria
      const memoryUsage = process.memoryUsage();
      this.metrics.performance.memoryUsage = {
        ...memoryUsage,
        history: [...this.metrics.performance.memoryUsage.history, {
          timestamp: new Date().toISOString(),
          heapUsed: memoryUsage.heapUsed,
          rss: memoryUsage.rss
        }]
      };
      
      // Limitar el historial de memoria a 60 puntos (5 horas)
      if (this.metrics.performance.memoryUsage.history.length > 60) {
        this.metrics.performance.memoryUsage.history.shift();
      }
      
      // CPU (si está disponible)
      if (process.cpuUsage) {
        const cpuUsage = process.cpuUsage();
        this.metrics.performance.cpuUsage = {
          ...cpuUsage,
          history: [...this.metrics.performance.cpuUsage.history, {
            timestamp: new Date().toISOString(),
            user: cpuUsage.user,
            system: cpuUsage.system
          }]
        };
        
        // Limitar el historial de CPU a 60 puntos
        if (this.metrics.performance.cpuUsage.history.length > 60) {
          this.metrics.performance.cpuUsage.history.shift();
        }
      }
      
      // Calcular tasa de mensajes por minuto
      const now = Date.now();
      const minutesPassed = (now - this.metrics.messages.lastMinuteTimestamp) / 60000;
      if (minutesPassed >= 1) {
        const newMessages = this.metrics.messages.total - this.metrics.messages.lastMinuteCount;
        this.metrics.messages.ratePerMinute = Math.round(newMessages / minutesPassed);
        this.metrics.messages.lastMinuteCount = this.metrics.messages.total;
        this.metrics.messages.lastMinuteTimestamp = now;
      }
      
      // Comprobar estado de Redis
      await this.checkRedisHealth();
      
    } catch (error) {
      logger.error({ error: error.message }, 'Error al actualizar métricas del sistema');
    }
  }
  
  /**
   * Comprueba el estado de salud de Redis y actualiza las métricas
   */
  async checkRedisHealth() {
    try {
      // Si no tenemos el servicio de Redis inicializado, no hacer nada
      if (!redisService) return;
      
      // Realizar health check de Redis
      const healthResult = await redisService.healthCheck();
      
      // Actualizar métricas de servicios externos
      if (!this.metrics.externalServices) {
        this.metrics.externalServices = {
          redis: {
            status: healthResult.status,
            responseTime: healthResult.responseTime,
            lastCheck: healthResult.timestamp,
            history: [],
            cacheStats: {
              hits: 0,
              misses: 0,
              ratio: '0%'
            }
          }
        };
      } else {
        // Guardar historial de estado
        if (!this.metrics.externalServices.redis.history) {
          this.metrics.externalServices.redis.history = [];
        }
        
        this.metrics.externalServices.redis.history.push({
          timestamp: healthResult.timestamp,
          status: healthResult.status,
          responseTime: healthResult.responseTime
        });
        
        // Limitar historial a 60 puntos
        if (this.metrics.externalServices.redis.history.length > 60) {
          this.metrics.externalServices.redis.history.shift();
        }
        
        // Actualizar estado actual
        this.metrics.externalServices.redis.status = healthResult.status;
        this.metrics.externalServices.redis.responseTime = healthResult.responseTime;
        this.metrics.externalServices.redis.lastCheck = healthResult.timestamp;
        
        // Actualizar estadísticas de caché
        if (healthResult.metrics) {
          this.metrics.externalServices.redis.cacheStats = {
            hits: healthResult.metrics.cacheHits,
            misses: healthResult.metrics.cacheMisses,
            ratio: healthResult.metrics.cacheHitRatio
          };
        }
      }
      
      // Si Redis no está saludable, generar una alerta
      if (healthResult.status === 'unhealthy') {
        this.metrics.alerts.triggered.unshift({
          type: 'redis_unhealthy',
          message: `Redis no está disponible: ${healthResult.error || 'Error desconocido'}`,
          value: 'unhealthy',
          timestamp: new Date().toISOString()
        });
        
        // Mantener solo las 10 alertas más recientes
        if (this.metrics.alerts.triggered.length > 10) {
          this.metrics.alerts.triggered.pop();
        }
        
        logger.error({ healthResult }, 'Redis no está disponible');
      } else if (healthResult.status === 'degraded') {
        // Si Redis está degradado, generar una alerta de menor severidad
        this.metrics.alerts.triggered.unshift({
          type: 'redis_degraded',
          message: `Redis está funcionando lento: ${healthResult.responseTime}ms`,
          value: healthResult.responseTime,
          timestamp: new Date().toISOString()
        });
        
        // Mantener solo las 10 alertas más recientes
        if (this.metrics.alerts.triggered.length > 10) {
          this.metrics.alerts.triggered.pop();
        }
        
        logger.warn({ responseTime: healthResult.responseTime }, 'Redis está funcionando lento');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Error al comprobar el estado de Redis');
    }
  }
  
  /**
   * Comprueba si se deben activar alertas basadas en umbrales
   */
  checkAlerts() {
    try {
      const alerts = [];
      const thresholds = this.metrics.alerts.thresholds;
      
      // Alerta de latencia alta
      if (this.metrics.performance.averageLatency > thresholds.highLatency) {
        alerts.push({
          type: 'high_latency',
          message: `Latencia promedio alta: ${this.metrics.performance.averageLatency.toFixed(2)}ms`,
          value: this.metrics.performance.averageLatency,
          threshold: thresholds.highLatency,
          timestamp: new Date().toISOString()
        });
      }
      
      // Alerta de tasa de errores alta
      if (this.metrics.errors.errorRate > thresholds.highErrorRate) {
        alerts.push({
          type: 'high_error_rate',
          message: `Tasa de errores alta: ${this.metrics.errors.errorRate.toFixed(2)}%`,
          value: this.metrics.errors.errorRate,
          threshold: thresholds.highErrorRate,
          timestamp: new Date().toISOString()
        });
      }
      
      // Alerta de uso de memoria alto
      const memoryPercent = (this.metrics.performance.memoryUsage.heapUsed / 
                           this.metrics.performance.memoryUsage.heapTotal) * 100;
      if (memoryPercent > thresholds.highMemoryUsage) {
        alerts.push({
          type: 'high_memory_usage',
          message: `Uso de memoria alto: ${memoryPercent.toFixed(2)}%`,
          value: memoryPercent,
          threshold: thresholds.highMemoryUsage,
          timestamp: new Date().toISOString()
        });
      }
      
      // Si hay alertas, registrarlas y notificar
      if (alerts.length > 0) {
        this.metrics.alerts.triggered = [
          ...alerts,
          ...this.metrics.alerts.triggered
        ].slice(0, 10); // Mantener solo las 10 alertas más recientes
        
        // Registrar alertas en el log
        alerts.forEach(alert => {
          logger.warn({ alert }, `Alerta de métricas: ${alert.message}`);
        });
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Error al comprobar alertas');
    }
  }
  
  /**
   * Limpia datos históricos antiguos para optimizar memoria
   */
  cleanupHistoricalData() {
    try {
      // Mantener solo las últimas 24 horas de historia de conexiones
      if (this.metrics.connections.history.length > 1440) {
        this.metrics.connections.history = this.metrics.connections.history.slice(-1440);
      }
      
      // Guardar datos históricos en Redis para análisis a largo plazo
      // y liberar memoria del servidor
      const dailyMetrics = {
        date: new Date().toISOString().split('T')[0],
        connections: {
          total: this.metrics.connections.total,
          peak: this.metrics.connections.peak
        },
        messages: {
          total: this.metrics.messages.total,
          byType: this.metrics.messages.byType
        },
        errors: {
          count: this.metrics.errors.count,
          byType: this.metrics.errors.byType
        },
        performance: {
          averageLatency: this.metrics.performance.averageLatency,
          p95Latency: this.metrics.performance.p95Latency
        }
      };
      
      // Guardar en Redis con expiración de 90 días
      const key = `metrics:daily:${dailyMetrics.date}`;
      redisService.set(key, dailyMetrics, 90 * 24 * 60 * 60);
      
      logger.info('Datos históricos de métricas limpiados y archivados');
    } catch (error) {
      logger.error({ error: error.message }, 'Error al limpiar datos históricos');
    }
  }

  /**
   * Registra una nueva conexión
   * @param {string} socketId - ID del socket
   * @param {Object} userData - Datos del usuario
   * @param {Object} metadata - Metadatos adicionales de la conexión
   */
  connectionCreated(socketId, userData, metadata = {}) {
    this.metrics.connections.total++;
    this.metrics.connections.active++;
    
    // Actualizar pico de conexiones si es necesario
    if (this.metrics.connections.active > this.metrics.connections.peak.count) {
      this.metrics.connections.peak = {
        count: this.metrics.connections.active,
        timestamp: new Date().toISOString()
      };
    }
    
    // Registrar datos por agente de usuario
    const userAgent = metadata.userAgent || 'unknown';
    const userAgentType = this.getUserAgentType(userAgent);
    this.metrics.connections.byUserAgent.set(
      userAgentType,
      (this.metrics.connections.byUserAgent.get(userAgentType) || 0) + 1
    );
    
    // Registrar datos por país/región (si está disponible)
    if (metadata.country) {
      this.metrics.connections.byCountry.set(
        metadata.country,
        (this.metrics.connections.byCountry.get(metadata.country) || 0) + 1
      );
    }
    
    logger.debug({ 
      socketId, 
      userId: userData?.id, 
      activeConnections: this.metrics.connections.active,
      userAgent: userAgentType
    }, 'Nueva conexión registrada');
  }
  
  /**
   * Determina el tipo de agente de usuario
   * @param {string} userAgent - String del User-Agent
   * @returns {string} - Tipo de agente de usuario
   */
  getUserAgentType(userAgent) {
    if (!userAgent) return 'unknown';
    
    userAgent = userAgent.toLowerCase();
    
    if (userAgent.includes('mobile') || userAgent.includes('android') || userAgent.includes('iphone')) {
      return 'mobile';
    } else if (userAgent.includes('tablet') || userAgent.includes('ipad')) {
      return 'tablet';
    } else if (userAgent.includes('chrome')) {
      return 'chrome';
    } else if (userAgent.includes('firefox')) {
      return 'firefox';
    } else if (userAgent.includes('safari')) {
      return 'safari';
    } else if (userAgent.includes('edge')) {
      return 'edge';
    } else if (userAgent.includes('bot') || userAgent.includes('crawler')) {
      return 'bot';
    } else {
      return 'other';
    }
  }

  /**
   * Registra una desconexión
   * @param {string} socketId - ID del socket
   */
  connectionClosed(socketId) {
    this.metrics.connections.active = Math.max(0, this.metrics.connections.active - 1);
    
    logger.debug({ 
      socketId, 
      activeConnections: this.metrics.connections.active 
    }, 'Conexión cerrada registrada');
  }

  /**
   * Registra un usuario unido a un workspace
   * @param {string} workspaceId - ID del workspace
   * @param {string} userId - ID del usuario
   */
  userJoinedWorkspace(workspaceId, userId) {
    const currentUsers = this.metrics.workspaces.active.get(workspaceId) || new Set();
    currentUsers.add(userId);
    this.metrics.workspaces.active.set(workspaceId, currentUsers);
    
    logger.debug({ 
      workspaceId, 
      userId, 
      userCount: currentUsers.size 
    }, 'Usuario unido a workspace');
  }

  /**
   * Registra un usuario saliendo de un workspace
   * @param {string} workspaceId - ID del workspace
   * @param {string} userId - ID del usuario
   */
  userLeftWorkspace(workspaceId, userId) {
    const currentUsers = this.metrics.workspaces.active.get(workspaceId) || new Set();
    currentUsers.delete(userId);
    
    if (currentUsers.size > 0) {
      this.metrics.workspaces.active.set(workspaceId, currentUsers);
    } else {
      this.metrics.workspaces.active.delete(workspaceId);
    }
    
    logger.debug({ 
      workspaceId, 
      userId, 
      userCount: currentUsers.size 
    }, 'Usuario salió del workspace');
  }

  /**
   * Registra un mensaje enviado
   * @param {string} type - Tipo de mensaje
   * @param {number} processingTime - Tiempo de procesamiento en ms
   * @param {Object} metadata - Metadatos adicionales del mensaje
   */
  messageProcessed(type, processingTime, metadata = {}) {
    this.metrics.messages.total++;
    this.metrics.messages.byType[type] = (this.metrics.messages.byType[type] || 0) + 1;
    
    if (processingTime) {
      this.metrics.performance.messageLatency.push(processingTime);
      
      // Mantener solo los últimos 1000 registros de latencia
      if (this.metrics.performance.messageLatency.length > 1000) {
        this.metrics.performance.messageLatency.shift();
      }
      
      // Actualizar latencia promedio
      const sum = this.metrics.performance.messageLatency.reduce((acc, val) => acc + val, 0);
      this.metrics.performance.averageLatency = sum / this.metrics.performance.messageLatency.length;
      
      // Calcular percentil 95 de latencia
      const sortedLatencies = [...this.metrics.performance.messageLatency].sort((a, b) => a - b);
      const idx = Math.floor(sortedLatencies.length * 0.95);
      this.metrics.performance.p95Latency = sortedLatencies[idx] || 0;
    }
    
    // Registrar tamaño del mensaje si está disponible
    if (metadata.size) {
      // Podríamos agregar métricas de tamaño de mensaje aquí
    }
    
    // Calcular tasa de errores
    if (this.metrics.messages.total > 0) {
      this.metrics.errors.errorRate = (this.metrics.errors.count / this.metrics.messages.total) * 100;
    }
  }

  /**
   * Registra un error
   * @param {string} type - Tipo de error
   * @param {Object} details - Detalles del error
   */
  errorOccurred(type, details) {
    this.metrics.errors.count++;
    this.metrics.errors.byType[type] = (this.metrics.errors.byType[type] || 0) + 1;
    
    // Guardar detalles del último error
    this.metrics.errors.lastError = {
      type,
      details,
      timestamp: new Date().toISOString()
    };
    
    // Calcular tasa de errores
    if (this.metrics.messages.total > 0) {
      this.metrics.errors.errorRate = (this.metrics.errors.count / this.metrics.messages.total) * 100;
    }
    
    // Comprobar si debemos generar una alerta por tasa de errores
    if (this.metrics.errors.errorRate > this.metrics.alerts.thresholds.highErrorRate) {
      // Si la tasa de errores supera el umbral, generar alerta inmediatamente
      this.metrics.alerts.triggered.unshift({
        type: 'high_error_rate',
        message: `Tasa de errores alta: ${this.metrics.errors.errorRate.toFixed(2)}%`,
        value: this.metrics.errors.errorRate,
        threshold: this.metrics.alerts.thresholds.highErrorRate,
        timestamp: new Date().toISOString()
      });
      
      // Mantener solo las 10 alertas más recientes
      if (this.metrics.alerts.triggered.length > 10) {
        this.metrics.alerts.triggered.pop();
      }
    }
    
    logger.error({ type, details }, 'Error registrado en métricas');
  }

  /**
   * Guarda un punto histórico de las métricas actuales
   */
  recordHistory() {
    const timestamp = new Date().toISOString();
    const snapshot = {
      timestamp,
      activeConnections: this.metrics.connections.active,
      activeWorkspaces: this.metrics.workspaces.active.size,
      messageCount: this.metrics.messages.total,
      errorCount: this.metrics.errors.count
    };
    
    this.metrics.connections.history.push(snapshot);
    
    // Mantener solo las últimas 24 horas de historia (1440 minutos)
    if (this.metrics.connections.history.length > 1440) {
      this.metrics.connections.history.shift();
    }
    
    logger.debug({ snapshot }, 'Métricas históricas registradas');
  }

  /**
   * Genera un informe de rendimiento con recomendaciones
   * @returns {Object} Informe de rendimiento
   */
  getPerformanceReport() {
    const report = {
      timestamp: new Date().toISOString(),
      performance: {
        averageLatency: this.metrics.performance.averageLatency.toFixed(2),
        p95Latency: this.metrics.performance.p95Latency.toFixed(2)
      },
      recommendations: []
    };

    if (this.metrics.performance.averageLatency > 500) {
      report.recommendations.push('Optimizar la base de datos para mejorar la latencia');
    }

    if (this.metrics.errors.errorRate > 5) {
      report.recommendations.push('Revisar y solucionar los errores para mejorar la estabilidad');
    }

    return report;
  }

  /**
   * Obtiene un resumen de las métricas actuales
   * @param {boolean} detailed - Si es true, incluye métricas detalladas
   * @returns {Object} Resumen de métricas
   */
  getMetricsSummary(detailed = false) {
    // Resumen básico de métricas
    const summary = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: {
        active: this.metrics.connections.active,
        total: this.metrics.connections.total,
        peak: this.metrics.connections.peak
      },
      messages: {
        total: this.metrics.messages.total,
        byType: this.metrics.messages.byType,
        ratePerMinute: this.metrics.messages.ratePerMinute
      },
      workspaces: {
        active: this.metrics.workspaces.active.size,
        users: Array.from(this.metrics.workspaces.active).map(([id, users]) => ({
          id,
          userCount: users.size
        })).sort((a, b) => b.userCount - a.userCount).slice(0, 10) // Top 10 workspaces
      },
      performance: {
        averageLatency: this.metrics.performance.averageLatency.toFixed(2),
        p95Latency: this.metrics.performance.p95Latency.toFixed(2)
      },
      errors: {
        count: this.metrics.errors.count,
        rate: this.metrics.errors.errorRate.toFixed(2) + '%',
        byType: this.metrics.errors.byType
      },
      alerts: {
        active: this.metrics.alerts.triggered.length > 0,
        recent: this.metrics.alerts.triggered.slice(0, 3) // 3 alertas más recientes
      },
      system: {
        memory: {
          heapUsed: Math.round(this.metrics.performance.memoryUsage.heapUsed / (1024 * 1024)) + ' MB',
          heapTotal: Math.round(this.metrics.performance.memoryUsage.heapTotal / (1024 * 1024)) + ' MB',
          rss: Math.round(this.metrics.performance.memoryUsage.rss / (1024 * 1024)) + ' MB'
        }
      },
      services: {}
    };
    
    // Añadir información de servicios externos si está disponible
    if (this.metrics.externalServices) {
      summary.services = {
        redis: {
          status: this.metrics.externalServices.redis?.status || 'unknown',
          responseTime: this.metrics.externalServices.redis?.responseTime || 0,
          lastCheck: this.metrics.externalServices.redis?.lastCheck || null,
          cacheStats: this.metrics.externalServices.redis?.cacheStats || {
            hits: 0,
            misses: 0,
            ratio: '0%'
          }
        }
      };
    }
    
    // Si se solicitan métricas detalladas, añadir más información
    if (detailed) {
      summary.connections.byUserAgent = Object.fromEntries(this.metrics.connections.byUserAgent);
      summary.connections.byCountry = Object.fromEntries(this.metrics.connections.byCountry);
      summary.connections.history = this.metrics.connections.history.slice(-60); // Última hora
      
      summary.performance.history = {
        memory: this.metrics.performance.memoryUsage.history.slice(-12), // Última hora
        cpu: this.metrics.performance.cpuUsage.history.slice(-12)
      };
      
      summary.alerts.all = this.metrics.alerts.triggered;
      summary.alerts.thresholds = this.metrics.alerts.thresholds;
      
      // Añadir historial de servicios externos si está disponible
      if (this.metrics.externalServices?.redis?.history) {
        summary.services.redis.history = this.metrics.externalServices.redis.history.slice(-12); // Últimos 12 puntos
      }
      
      // Añadir información del circuit breaker de Redis
      if (redisService) {
        try {
          const redisMetrics = redisService.getMetrics();
          summary.services.redis.circuitBreaker = {
            status: redisMetrics.circuitBreakerStatus,
            failureCount: redisMetrics.failureCount,
            reconnectAttempts: redisMetrics.reconnectAttempts
          };
        } catch (error) {
          logger.error({ error: error.message }, 'Error al obtener métricas detalladas de Redis');
        }
      }
    }
    
    return summary;
  }
}

// Singleton para usar en toda la aplicación
const metricsService = new MetricsService();

module.exports = metricsService;
