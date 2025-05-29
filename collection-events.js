// collection-events.js
// Funciones para manejar eventos relacionados con colecciones

/**
 * Notifica a todos los usuarios conectados que una colección ha sido eliminada
 * @param {Object} io - Instancia de Socket.IO
 * @param {String} workspaceId - ID del workspace al que pertenece la colección
 * @param {String} collectionId - ID de la colección eliminada
 * @param {Object} deletedBy - Información del usuario que eliminó la colección
 */
function notifyCollectionDeleted(io, workspaceId, collectionId, deletedBy) {
  if (!io || !workspaceId || !collectionId) return;
  
  console.log(`Notificando eliminación de la colección ${collectionId} en workspace ${workspaceId} por ${deletedBy?.email || 'desconocido'}`);
  
  // Emitir evento a todos los usuarios en el workspace
  io.to(workspaceId).emit('collection_deleted', {
    workspaceId,
    collectionId,
    deletedBy: deletedBy || { name: 'Administrador' },
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  notifyCollectionDeleted
};
