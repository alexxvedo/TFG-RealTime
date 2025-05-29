// workspace-events.js
// Funciones para manejar eventos relacionados con workspaces

/**
 * Notifica a todos los usuarios conectados que un workspace ha sido eliminado
 * @param {Object} io - Instancia de Socket.IO
 * @param {String} workspaceId - ID del workspace eliminado
 * @param {Object} deletedBy - Información del usuario que eliminó el workspace
 */
function notifyWorkspaceDeleted(io, workspaceId, deletedBy) {
  if (!io || !workspaceId) return;
  
  console.log(`Notificando eliminación del workspace ${workspaceId} por ${deletedBy?.email || 'desconocido'}`);
  
  // Emitir evento a todos los usuarios en el workspace
  io.to(workspaceId).emit('workspace_deleted', {
    workspaceId,
    deletedBy: deletedBy || { name: 'Administrador' },
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  notifyWorkspaceDeleted
};
