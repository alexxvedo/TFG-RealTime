const logger = require('../utils/logger');

/**
 * Servicio para recopilar y monitorear métricas del servidor WebSocket
 */
class MetricsService {
  constructor() {
    this.metrics = {
      connections: {
        total: 0,
        active: 0,
        history: []
      },
      messages: {
        total: 0,
        byType: {}
      },
      workspaces: {
        active: new Map(), // workspaceId -> número de usuarios
      },
      collections: {
        active: new Map(), // collectionId -> número de usuarios
      },
      errors: {
        count: 0,
        byType: {}
      },
      performance: {
        messageLatency: [] // Array de tiempos de procesamiento de mensajes
      }
    };

    // Guardar métricas cada minuto para análisis histórico
    setInterval(() => this.recordHistory(), 60000);
  }

  /**
   * Registra una nueva conexión
   * @param {string} socketId - ID del socket
   * @param {Object} userData - Datos del usuario
   */
  connectionCreated(socketId, userData) {
    this.metrics.connections.total++;
    this.metrics.connections.active++;
    
    logger.debug({ 
      socketId, 
      userId: userData?.id, 
      activeConnections: this.metrics.connections.active 
    }, 'Nueva conexión registrada');
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
   */
  messageProcessed(type, processingTime) {
    this.metrics.messages.total++;
    this.metrics.messages.byType[type] = (this.metrics.messages.byType[type] || 0) + 1;
    
    if (processingTime) {
      this.metrics.performance.messageLatency.push(processingTime);
      
      // Mantener solo los últimos 1000 registros de latencia
      if (this.metrics.performance.messageLatency.length > 1000) {
        this.metrics.performance.messageLatency.shift();
      }
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
   * Obtiene un resumen de las métricas actuales
   * @returns {Object} Resumen de métricas
   */
  getMetricsSummary() {
    // Calcular latencia promedio de los últimos 100 mensajes
    let avgLatency = 0;
    const recentLatency = this.metrics.performance.messageLatency.slice(-100);
    if (recentLatency.length > 0) {
      avgLatency = recentLatency.reduce((sum, val) => sum + val, 0) / recentLatency.length;
    }
    
    return {
      connections: {
        active: this.metrics.connections.active,
        total: this.metrics.connections.total
      },
      messages: {
        total: this.metrics.messages.total,
        byType: this.metrics.messages.byType
      },
      workspaces: {
        active: this.metrics.workspaces.active.size,
        users: Array.from(this.metrics.workspaces.active).map(([id, users]) => ({
          id,
          userCount: users.size
        }))
      },
      performance: {
        averageLatency: avgLatency.toFixed(2)
      },
      errors: {
        count: this.metrics.errors.count,
        byType: this.metrics.errors.byType
      }
    };
  }
}

// Singleton para usar en toda la aplicación
const metricsService = new MetricsService();

module.exports = metricsService;
