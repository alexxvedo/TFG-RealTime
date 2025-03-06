// server.js (Servidor de WebSockets)

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

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
let userLastSeen = new Map(); // workspaceId -> Map<userId -> timestamp>

io.on("connection", (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

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

    socket.join(workspaceId);

    const connectedUsers = Array.from(workspaceSockets[workspaceId].values());
    io.to(workspaceId).emit("users_connected", connectedUsers);

    const messages = workspaceMessages.get(workspaceId) || [];
    socket.emit("message_history", messages);

    io.to(workspaceId).emit("user_joined", userData);
  });

  // Manejar solicitud de estado inicial de usuarios en colecciones
  socket.on("get_collections_users", (workspaceId) => {
    console.log(`Solicitando usuarios de colecciones para workspace ${workspaceId}`);
    
    if (collectionUsers.has(workspaceId)) {
      const workspaceCollections = collectionUsers.get(workspaceId);
      
      // Emitir el estado de usuarios para cada colección
      workspaceCollections.forEach((users, collectionId) => {
        const usersInCollection = Array.from(users.values());
        console.log("Sending collection users:", { collectionId, users: usersInCollection });
        socket.emit("collection_users_updated", {
          collectionId,
          users: usersInCollection,
        });
      });
    }
  });

  socket.on("join_collection", (workspaceId, collectionId, userData) => {
    console.log("Join collection request:", { workspaceId, collectionId, userData });

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

    const collectionUserMap = collectionUsers.get(workspaceId).get(collectionId);
    
    // Verificar si el usuario ya está en la colección
    const existingUserData = Array.from(collectionUserMap.values())
      .find(user => user.email === userData.email);
    
    if (!existingUserData) {
      // Añadir usuario a la colección solo si no existe
      collectionUserMap.set(socket.id, userData);
      console.log(`Usuario ${userData.email} añadido a la colección ${collectionId}`);

      // Unirse a la sala específica de la colección
      socket.join(`${workspaceId}:${collectionId}`);

      // Notificar a todos en el workspace que un usuario entró a la colección
      io.to(workspaceId).emit("user_entered_collection", {
        collectionId,
        user: userData,
      });

      // Emitir lista actualizada de usuarios en la colección
      const usersInCollection = Array.from(collectionUserMap.values());
      console.log(`Usuarios actuales en la colección ${collectionId}:`, usersInCollection);
      io.to(workspaceId).emit("collection_users_updated", {
        collectionId,
        users: usersInCollection,
      });
    } else {
      console.log(`Usuario ${userData.email} ya está en la colección ${collectionId}`);
    }
  });

  socket.on("leave_collection", (workspaceId, collectionId) => {
    console.log(`Socket ${socket.id} leaving collection ${collectionId} in workspace ${workspaceId}`);
    
    if (
      collectionUsers.has(workspaceId) &&
      collectionUsers.get(workspaceId).has(collectionId)
    ) {
      const collectionUserMap = collectionUsers.get(workspaceId).get(collectionId);
      const userData = collectionUserMap.get(socket.id);
      
      if (userData) {
        console.log(`Removing user ${userData.email} from collection ${collectionId}`);
        
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
          user: userData
        });

        // Emitir lista actualizada de usuarios
        const usersInCollection = Array.from(collectionUserMap.values());
        console.log(`Updated users in collection ${collectionId}:`, usersInCollection);
        io.to(workspaceId).emit("collection_users_updated", {
          collectionId,
          users: usersInCollection,
        });
      } else {
        console.log(`No user data found for socket ${socket.id} in collection ${collectionId}`);
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
                user: userData
              });

              // Emitir lista actualizada de usuarios
              const usersInCollection = Array.from(users.values());
              io.to(workspaceId).emit("collection_users_updated", {
                collectionId,
                users: usersInCollection
              });

              // Limpiar colecciones vacías
              if (users.size === 0) {
                collectionUsers.get(workspaceId).delete(collectionId);
              }
            }
          });
        }

        // Dejar la sala del workspace
        socket.leave(workspaceId);
        
        // Notificar a todos que el usuario salió
        io.to(workspaceId).emit("user_left", userData);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    
    // Encontrar el workspace al que pertenece este socket
    let userWorkspaceId = null;
    let userData = null;

    // Buscar en todos los workspaces
    Object.entries(workspaceSockets).forEach(([wsId, users]) => {
      if (users.has(socket.id)) {
        userWorkspaceId = wsId;
        userData = users.get(socket.id);
      }
    });

    if (userWorkspaceId && userData) {
      console.log(`Usuario ${userData.email} desconectado del workspace ${userWorkspaceId}`);
      
      // Limpiar usuario de todas las colecciones del workspace
      if (collectionUsers.has(userWorkspaceId)) {
        const workspaceCollections = collectionUsers.get(userWorkspaceId);
        
        workspaceCollections.forEach((users, collectionId) => {
          if (users.has(socket.id)) {
            console.log(`Removing disconnected user ${userData.email} from collection ${collectionId}`);
            users.delete(socket.id);

            // Notificar que el usuario salió de la colección
            io.to(userWorkspaceId).emit("user_left_collection", {
              collectionId,
              user: userData
            });

            // Emitir lista actualizada de usuarios
            const usersInCollection = Array.from(users.values());
            console.log(`Users in collection ${collectionId} after disconnect:`, usersInCollection);
            io.to(userWorkspaceId).emit("collection_users_updated", {
              collectionId,
              users: usersInCollection
            });

            // Limpiar colecciones vacías
            if (users.size === 0) {
              console.log(`Collection ${collectionId} is empty after disconnect, removing it`);
              workspaceCollections.delete(collectionId);
            }
          }
        });

        // Si no quedan colecciones en el workspace, limpiar el workspace
        if (workspaceCollections.size === 0) {
          console.log(`No collections left in workspace ${userWorkspaceId}, removing workspace from collections`);
          collectionUsers.delete(userWorkspaceId);
        }
      }

      // Eliminar usuario del workspace
      workspaceSockets[userWorkspaceId].delete(socket.id);
      
      // Actualizar última vez visto
      if (userLastSeen.has(userWorkspaceId)) {
        userLastSeen.get(userWorkspaceId).set(userData.email, new Date());
      }

      // Notificar a todos los usuarios del workspace
      io.to(userWorkspaceId).emit("user_left", userData);
      
      const remainingUsers = Array.from(workspaceSockets[userWorkspaceId].values());
      io.to(userWorkspaceId).emit("users_connected", remainingUsers);
    }
  });

  // Eventos de chat
  socket.on("user_typing", ({ workspaceId, email, name }) => {
    io.to(workspaceId).emit("user_typing", { email, name });
  });

  socket.on("user_stop_typing", ({ workspaceId, email }) => {
    const userData = workspaceSockets[workspaceId]?.get(socket.id);
    io.to(workspaceId).emit("user_stop_typing", {
      email,
      name: userData?.name,
    });
  });

  socket.on("new_message", (message) => {
    io.to(message.workspaceId).emit("new_message", message);
  });

  socket.on("crear_collection", (workspaceId) => {
    io.to(workspaceId).emit("receive_collection");
  });
});

// Manejo de errores del servidor
process.on('uncaughtException', (error) => {
  console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});

server.on('error', (error) => {
  console.error('Error en el servidor HTTP:', error);
});

io.on('error', (error) => {
  console.error('Error en Socket.IO:', error);
});

server.listen(3001, () => {
  console.log("Servidor escuchando en el puerto 3001");
});
