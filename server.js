// server.js (Servidor de WebSockets)

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { notifyWorkspaceDeleted } = require('./workspace-events');
const { notifyCollectionDeleted } = require('./collection-events');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Almacenamiento en memoria
let workspaceSockets = {}; // workspaceId -> Map(socketId -> userData)
let collectionUsers = new Map(); // workspaceId -> Map(collectionId -> Map(socketId -> userData))
let workspaceMessages = new Map(); // workspaceId -> Array<Message>
let userLastSeen = new Map(); // workspaceId -> Map<userId -> timestamp)
let noteUsers = new Map(); // noteId -> Array<{id, userData}>
let noteContents = new Map(); // noteId -> content
let typingUsers = new Map(); // workspaceId -> Map(userId -> {name, timestamp})

io.on("connection", (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);
  
  // Manejar evento de eliminación de workspace
  socket.on("workspace_deleted", (data) => {
    const { workspaceId, deletedBy } = data;
    console.log(`Workspace ${workspaceId} eliminado por ${deletedBy?.email || 'desconocido'}`);
    
    // Notificar a todos los usuarios conectados al workspace
    notifyWorkspaceDeleted(io, workspaceId, deletedBy);
    
    // Limpiar datos del workspace eliminado
    if (workspaceSockets[workspaceId]) {
      delete workspaceSockets[workspaceId];
    }
    
    if (collectionUsers.has(workspaceId)) {
      collectionUsers.delete(workspaceId);
    }
    
    if (workspaceMessages.has(workspaceId)) {
      workspaceMessages.delete(workspaceId);
    }
    
    if (userLastSeen.has(workspaceId)) {
      userLastSeen.delete(workspaceId);
    }
    
    if (typingUsers.has(workspaceId)) {
      typingUsers.delete(workspaceId);
    }
  });
  
  // Manejar evento de eliminación de colección
  socket.on("collection_deleted", (data) => {
    const { workspaceId, collectionId, deletedBy } = data;
    console.log(`Colección ${collectionId} en workspace ${workspaceId} eliminada por ${deletedBy?.email || 'desconocido'}`);
    
    // Notificar a todos los usuarios conectados al workspace
    notifyCollectionDeleted(io, workspaceId, collectionId, deletedBy);
    
    // Limpiar datos de la colección eliminada
    if (collectionUsers.has(workspaceId) && collectionUsers.get(workspaceId).has(collectionId)) {
      collectionUsers.get(workspaceId).delete(collectionId);
    }
  });

  socket.on("join_workspace", (workspaceId, userData) => {
    console.log(
      `${socket.id} == ${userData.email} ha entrado al workspace ${workspaceId}`
    );

    if (!workspaceSockets[workspaceId]) {
      workspaceSockets[workspaceId] = new Map();
    }
    workspaceSockets[workspaceId].set(socket.id, userData);

    if (!workspaceMessages.has(workspaceId)) {
      workspaceMessages.set(workspaceId, []);
    }

    if (!userLastSeen.has(workspaceId)) {
      userLastSeen.set(workspaceId, new Map());
    }
    userLastSeen.get(workspaceId).set(userData.email, new Date());

    // Inicializar mapa de usuarios escribiendo
    if (!typingUsers.has(workspaceId)) {
      typingUsers.set(workspaceId, new Map());
    }

    socket.join(workspaceId);

    const connectedUsers = Array.from(workspaceSockets[workspaceId].values());
    io.to(workspaceId).emit("users_connected", connectedUsers);

    const messages = workspaceMessages.get(workspaceId) || [];
    socket.emit("message_history", messages);

    io.to(workspaceId).emit("user_joined", userData);
  });

  // Nuevo manejador para obtener usuarios del workspace
  socket.on("get_workspace_users", (workspaceId) => {
    console.log(`Solicitud de usuarios para workspace ${workspaceId} desde ${socket.id}`);
    
    if (workspaceSockets[workspaceId]) {
      const connectedUsers = Array.from(workspaceSockets[workspaceId].values());
      console.log(`Enviando ${connectedUsers.length} usuarios conectados al workspace ${workspaceId}`);
      socket.emit("users_connected", connectedUsers);
    } else {
      console.log(`No hay usuarios registrados en el workspace ${workspaceId}`);
      socket.emit("users_connected", []);
    }
  });

  // Manejar eventos de chat
  socket.on("new_message", (messageData) => {
    const { workspaceId, senderEmail, senderName, senderImage, content } = messageData;
    
    if (!workspaceId || !content || !senderEmail) {
      console.log("Mensaje inválido recibido:", messageData);
      return;
    }

    console.log(`Nuevo mensaje en workspace ${workspaceId} de ${senderEmail}: ${content}`);
    
    // Crear objeto de mensaje
    const newMessage = {
      id: Date.now().toString(),
      workspaceId,
      senderEmail,
      senderName,
      senderImage,
      content,
      timestamp: new Date().toISOString()
    };
    
    // Guardar mensaje en memoria
    if (!workspaceMessages.has(workspaceId)) {
      workspaceMessages.set(workspaceId, []);
    }
    workspaceMessages.get(workspaceId).push(newMessage);
    
    // Limitar la cantidad de mensajes almacenados (opcional)
    const maxMessages = 100;
    const messages = workspaceMessages.get(workspaceId);
    if (messages.length > maxMessages) {
      workspaceMessages.set(workspaceId, messages.slice(-maxMessages));
    }
    
    // Emitir mensaje a todos los usuarios en el workspace
    io.to(workspaceId).emit("new_message", newMessage);
    
    // Limpiar estado de "escribiendo" para el usuario que envió el mensaje
    if (typingUsers.has(workspaceId)) {
      const workspaceTypingUsers = typingUsers.get(workspaceId);
      if (workspaceTypingUsers.has(senderEmail)) {
        workspaceTypingUsers.delete(senderEmail);
        io.to(workspaceId).emit("user_stop_typing", { 
          email: senderEmail, 
          name: senderName 
        });
      }
    }
  });
  
  // Manejar indicador de "escribiendo"
  socket.on("user_typing", (data) => {
    const { workspaceId, email, name } = data;
    
    if (!workspaceId || !email) return;
    
    console.log(`Usuario ${name} (${email}) está escribiendo en workspace ${workspaceId}`);
    
    // Actualizar estado de "escribiendo"
    if (!typingUsers.has(workspaceId)) {
      typingUsers.set(workspaceId, new Map());
    }
    
    typingUsers.get(workspaceId).set(email, {
      name,
      timestamp: Date.now()
    });
    
    // Emitir evento a todos los usuarios en el workspace
    io.to(workspaceId).emit("user_typing", { email, name });
  });
  
  // Manejar fin de "escribiendo"
  socket.on("user_stop_typing", (data) => {
    const { workspaceId, email } = data;
    
    if (!workspaceId || !email) return;
    
    console.log(`Usuario ${email} dejó de escribir en workspace ${workspaceId}`);
    
    // Actualizar estado de "escribiendo"
    if (typingUsers.has(workspaceId)) {
      const workspaceTypingUsers = typingUsers.get(workspaceId);
      const userData = workspaceTypingUsers.get(email);
      
      if (userData) {
        workspaceTypingUsers.delete(email);
        
        // Emitir evento a todos los usuarios en el workspace
        io.to(workspaceId).emit("user_stop_typing", { 
          email, 
          name: userData.name 
        });
      }
    }
  });

  // Manejar solicitud de estado inicial de usuarios en colecciones
  socket.on("get_collections_users", (workspaceId) => {
    console.log(
      `Solicitando usuarios de colecciones para workspace ${workspaceId}`
    );

    if (collectionUsers.has(workspaceId)) {
      const workspaceCollections = collectionUsers.get(workspaceId);

      // Emitir el estado de usuarios para cada colección
      workspaceCollections.forEach((users, collectionId) => {
        const usersInCollection = Array.from(users.values());
        console.log("Sending collection users:", {
          collectionId,
          users: usersInCollection,
        });
        socket.emit("collection_users_updated", {
          collectionId,
          users: usersInCollection,
        });
      });
    }
  });

  socket.on("join_collection", (workspaceId, collectionId, userData) => {
    console.log("Join collection request:", {
      workspaceId,
      collectionId,
      userData,
    });

    console.log(
      `${userData.email} ha entrado a la colección ${collectionId} del workspace ${workspaceId}`
    );

    // Inicializar estructuras si no existen
    if (!collectionUsers.has(workspaceId)) {
      collectionUsers.set(workspaceId, new Map());
    }
    if (!collectionUsers.get(workspaceId).has(collectionId)) {
      collectionUsers.get(workspaceId).set(collectionId, new Map());
    }

    const collectionUserMap = collectionUsers
      .get(workspaceId)
      .get(collectionId);

    // Verificar si el usuario ya está en la colección
    const existingUserData = Array.from(collectionUserMap.values()).find(
      (user) => user.email === userData.email
    );

    if (!existingUserData) {
      // Añadir usuario a la colección solo si no existe
      collectionUserMap.set(socket.id, userData);
      console.log(
        `Usuario ${userData.email} añadido a la colección ${collectionId}`
      );

      // Unirse a la sala específica de la colección
      socket.join(`${workspaceId}:${collectionId}`);

      // Notificar a todos en el workspace que un usuario entró a la colección
      io.to(workspaceId).emit("user_entered_collection", {
        collectionId,
        user: userData,
      });

      // Emitir lista actualizada de usuarios en la colección
      const usersInCollection = Array.from(collectionUserMap.values());
      console.log(
        `Usuarios actuales en la colección ${collectionId}:`,
        usersInCollection
      );
      io.to(workspaceId).emit("collection_users_updated", {
        collectionId,
        users: usersInCollection,
      });
    } else {
      console.log(
        `Usuario ${userData.email} ya está en la colección ${collectionId}`
      );
    }
  });

  socket.on("leave_collection", (workspaceId, collectionId) => {
    console.log(
      `Socket ${socket.id} leaving collection ${collectionId} in workspace ${workspaceId}`
    );

    if (
      collectionUsers.has(workspaceId) &&
      collectionUsers.get(workspaceId).has(collectionId)
    ) {
      const collectionUserMap = collectionUsers
        .get(workspaceId)
        .get(collectionId);
      const userData = collectionUserMap.get(socket.id);

      if (userData) {
        console.log(
          `Removing user ${userData.email} from collection ${collectionId}`
        );

        // Eliminar usuario de la colección
        collectionUserMap.delete(socket.id);

        // Si la colección está vacía, limpiarla
        if (collectionUserMap.size === 0) {
          console.log(`Collection ${collectionId} is empty, removing it`);
          collectionUsers.get(workspaceId).delete(collectionId);
        }

        // Dejar la sala de la colección
        socket.leave(`${workspaceId}:${collectionId}`);

        // Notificar que el usuario salió de la colección
        io.to(workspaceId).emit("user_left_collection", {
          collectionId,
          user: userData,
        });

        // Emitir lista actualizada de usuarios
        const usersInCollection = Array.from(collectionUserMap.values());
        console.log(
          `Updated users in collection ${collectionId}:`,
          usersInCollection
        );
        io.to(workspaceId).emit("collection_users_updated", {
          collectionId,
          users: usersInCollection,
        });
      } else {
        console.log(
          `No user data found for socket ${socket.id} in collection ${collectionId}`
        );
      }
    }
  });

  socket.on("leave_workspace", (workspaceId) => {
    console.log(`Usuario ${socket.id} saliendo del workspace ${workspaceId}`);

    if (workspaceSockets[workspaceId]) {
      const userData = workspaceSockets[workspaceId].get(socket.id);
      if (userData) {
        // Eliminar usuario del workspace
        workspaceSockets[workspaceId].delete(socket.id);

        // Limpiar usuario de todas las colecciones del workspace
        if (collectionUsers.has(workspaceId)) {
          collectionUsers.get(workspaceId).forEach((users, collectionId) => {
            if (users.has(socket.id)) {
              users.delete(socket.id);

              // Notificar que el usuario salió de la colección
              io.to(workspaceId).emit("user_left_collection", {
                collectionId,
                user: userData,
              });

              // Emitir lista actualizada de usuarios
              const usersInCollection = Array.from(users.values());
              io.to(workspaceId).emit("collection_users_updated", {
                collectionId,
                users: usersInCollection,
              });

              // Limpiar colecciones vacías
              if (users.size === 0) {
                collectionUsers.get(workspaceId).delete(collectionId);
              }
            }
          });
        }

        // Limpiar estado de "escribiendo" para el usuario
        if (typingUsers.has(workspaceId)) {
          const workspaceTypingUsers = typingUsers.get(workspaceId);
          if (workspaceTypingUsers.has(userData.email)) {
            workspaceTypingUsers.delete(userData.email);
            io.to(workspaceId).emit("user_stop_typing", { 
              email: userData.email, 
              name: userData.name 
            });
          }
        }

        socket.leave(workspaceId);

        // Actualizar última vez visto
        if (userLastSeen.has(workspaceId)) {
          userLastSeen.get(workspaceId).set(userData.email, new Date());
        }

        // Notificar a otros usuarios
        const connectedUsers = Array.from(
          workspaceSockets[workspaceId].values()
        );
        io.to(workspaceId).emit("users_connected", connectedUsers);
        io.to(workspaceId).emit("user_left", userData);
      }
    }
  });

  socket.on("join_note", (workspaceId, noteId, userData) => {
    try {
      // Asegurarnos de que la lista de usuarios existe
      if (!noteUsers.has(noteId)) {
        noteUsers.set(noteId, []);
      }

      const usersList = noteUsers.get(noteId);
      const existingUserIndex = usersList.findIndex(u => u.id === socket.id);

      if (existingUserIndex === -1) {
        // Añadir nuevo usuario
        usersList.push({
          id: socket.id,
          userData: userData
        });
      } else {
        // Actualizar datos del usuario existente
        usersList[existingUserIndex].userData = userData;
      }

      // Unirse a la sala de socket.io
      socket.join(`${noteId}`);

      // Enviar la lista actualizada de usuarios
      io.to(`${noteId}`).emit("note_users_updated", {
        noteId,
        users: usersList.map(u => u.userData)
      });

      // Enviar el contenido actual de la nota si existe
      if (noteContents.has(noteId)) {
        socket.emit("note_content_updated", {
          noteId,
          content: noteContents.get(noteId)
        });
      }

      console.log(`Usuario ${userData.email} ha entrado a la nota ${noteId}`);
    } catch (error) {
      console.error("Error al unirse a la nota:", error);
    }
  });

  socket.on("leave_note", (noteId) => {
    try {
      if (!noteUsers.has(noteId)) {
        return;
      }

      const usersList = noteUsers.get(noteId);
      const leavingUser = usersList.find(u => u.id === socket.id);
      
      if (leavingUser) {
        // Actualizar la lista de usuarios
        const updatedUsers = usersList.filter(u => u.id !== socket.id);
        noteUsers.set(noteId, updatedUsers);

        // Notificar que el cursor ya no está
        io.to(`${noteId}`).emit("cursor_updated", {
          noteId,
          userId: socket.id,
          userData: leavingUser.userData,
          cursor: null,
        });

        // Notificar la actualización de usuarios
        io.to(`${noteId}`).emit("note_users_updated", {
          noteId,
          users: updatedUsers.map(u => u.userData)
        });

        // Salir de la sala de socket.io
        socket.leave(`${noteId}`);
        console.log(`Usuario ${leavingUser.userData.email} ha salido de la nota ${noteId}`);
      }
    } catch (error) {
      console.error("Error al salir de la nota:", error);
    }
  });

  // Manejo de cursores
  socket.on("cursor_update", (noteId, cursorData) => {
    try {
      console.log("Recibido evento cursor_update:", {
        socketId: socket.id,
        noteId,
        cursorData
      });

      if (!noteUsers.has(noteId)) {
        console.log("Nota no encontrada:", noteId);
        return;
      }

      const usersList = noteUsers.get(noteId);
      const user = usersList.find(u => u.id === socket.id);
      
      if (!user) {
        console.log("Usuario no encontrado en la nota:", {
          socketId: socket.id,
          noteId,
          usersInNote: usersList.length
        });
        return;
      }

      console.log(`Cursor actualizado para ${user.userData.email}:`, {
        from: cursorData.from,
        to: cursorData.to,
        noteId
      });
      
      // Emitir la actualización del cursor a todos los usuarios en la nota
      io.to(`${noteId}`).emit("cursor_updated", {
        noteId,
        userId: socket.id,
        userData: user.userData,
        cursor: cursorData
      });
    } catch (error) {
      console.error("Error al actualizar el cursor:", error);
    }
  });

  socket.on("note_content_update", (noteId, content) => {
    if (noteUsers.has(noteId)) {
      // Guardar el nuevo contenido
      noteContents.set(noteId, content);

      // Emitir actualización a todos los usuarios en la nota
      io.to(`${noteId}`).emit("note_content_updated", {
        noteId,
        content,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Usuario desconectado: ${socket.id}`);

    // Limpiar usuario de todas las notas
    noteUsers.forEach((users, noteId) => {
      if (users.find(u => u.id === socket.id)) {
        const updatedUsers = users.filter(u => u.id !== socket.id);
        noteUsers.set(noteId, updatedUsers);

        if (updatedUsers.length === 0) {
          noteUsers.delete(noteId);
          noteContents.delete(noteId);
        } else {
          // Notificar a otros usuarios
          const remainingUsers = updatedUsers;
          io.to(`${noteId}`).emit("note_users_updated", {
            noteId,
            users: remainingUsers.map(u => u.userData),
          });
        }
      }
    });

    // Limpiar usuario de todas las colecciones y workspaces
    Object.keys(workspaceSockets).forEach((workspaceId) => {
      if (workspaceSockets[workspaceId].has(socket.id)) {
        const userData = workspaceSockets[workspaceId].get(socket.id);
        workspaceSockets[workspaceId].delete(socket.id);

        // Limpiar estado de "escribiendo" para el usuario
        if (typingUsers.has(workspaceId) && userData) {
          const workspaceTypingUsers = typingUsers.get(workspaceId);
          if (workspaceTypingUsers.has(userData.email)) {
            workspaceTypingUsers.delete(userData.email);
            io.to(workspaceId).emit("user_stop_typing", { 
              email: userData.email, 
              name: userData.name 
            });
          }
        }

        // Actualizar última vez visto
        if (userLastSeen.has(workspaceId)) {
          userLastSeen.get(workspaceId).set(userData.email, new Date());
        }

        // Notificar a otros usuarios
        const connectedUsers = Array.from(
          workspaceSockets[workspaceId].values()
        );
        io.to(workspaceId).emit("users_connected", connectedUsers);
        io.to(workspaceId).emit("user_left", userData);
      }
    });
  });
});

// Limpiar periódicamente los estados de "escribiendo" (para evitar estados fantasma)
setInterval(() => {
  const typingTimeout = 5000; // 5 segundos
  const now = Date.now();
  
  typingUsers.forEach((workspaceTypingUsers, workspaceId) => {
    workspaceTypingUsers.forEach((userData, email) => {
      if (now - userData.timestamp > typingTimeout) {
        workspaceTypingUsers.delete(email);
        io.to(workspaceId).emit("user_stop_typing", { 
          email, 
          name: userData.name 
        });
      }
    });
  });
}, 5000);

// Manejo de errores del servidor
process.on("uncaughtException", (error) => {
  console.error("Error no capturado:", error);
  // Aquí podrías implementar un sistema de logging más robusto
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Promesa rechazada no manejada:", reason);
  // Aquí podrías implementar un sistema de logging más robusto
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
});
