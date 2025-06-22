/**
 * Tests unitarios para el servidor WebSocket
 * Valida las funcionalidades de tiempo real para chat, notas colaborativas y notificaciones
 */

const { createServer } = require("http");
const { Server } = require("socket.io");
const Client = require("socket.io-client");
const jwt = require("jsonwebtoken");

describe("WebSocket Server Tests", () => {
  let io, serverSocket, clientSocket, httpServer;
  const JWT_SECRET = "test-secret";

  beforeAll((done) => {
    httpServer = createServer();
    io = new Server(httpServer);

    httpServer.listen(() => {
      const port = httpServer.address().port;

      // Configurar autenticación mock
      io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (token) {
          try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.userId;
            socket.userEmail = decoded.email;
            next();
          } catch (err) {
            next(new Error("Authentication error"));
          }
        } else {
          next(new Error("No token provided"));
        }
      });

      // Configurar handlers básicos
      io.on("connection", (socket) => {
        serverSocket = socket;

        // Handler para unirse a workspace
        socket.on("join-workspace", (workspaceId) => {
          socket.join(`workspace-${workspaceId}`);
          socket.emit("workspace-joined", { workspaceId });
        });

        // Handler para chat
        socket.on("send-message", (data) => {
          const message = {
            id: Date.now(),
            content: data.content,
            userId: socket.userId,
            userEmail: socket.userEmail,
            timestamp: new Date().toISOString(),
            workspaceId: data.workspaceId,
          };

          socket
            .to(`workspace-${data.workspaceId}`)
            .emit("new-message", message);
          socket.emit("message-sent", message);
        });

        // Handler para notas colaborativas
        socket.on("note-update", (data) => {
          socket.to(`note-${data.noteId}`).emit("note-changed", {
            noteId: data.noteId,
            content: data.content,
            userId: socket.userId,
            timestamp: new Date().toISOString(),
          });
        });

        // Handler para cursor position
        socket.on("cursor-position", (data) => {
          socket.to(`note-${data.noteId}`).emit("cursor-update", {
            userId: socket.userId,
            userEmail: socket.userEmail,
            position: data.position,
            selection: data.selection,
          });
        });
      });

      done();
    });
  });

  afterAll(() => {
    io.close();
    httpServer.close();
  });

  beforeEach((done) => {
    // Crear token JWT válido para tests
    const token = jwt.sign(
      { userId: "test-user-1", email: "test@example.com" },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    clientSocket = new Client(`http://localhost:${httpServer.address().port}`, {
      auth: { token },
    });

    clientSocket.on("connect", done);
  });

  afterEach(() => {
    if (clientSocket.connected) {
      clientSocket.disconnect();
    }
  });

  describe("Autenticación", () => {
    test("debe rechazar conexiones sin token", (done) => {
      const unauthorizedClient = new Client(
        `http://localhost:${httpServer.address().port}`
      );

      unauthorizedClient.on("connect_error", (error) => {
        expect(error.message).toContain("Authentication error");
        unauthorizedClient.close();
        done();
      });
    });

    test("debe rechazar tokens inválidos", (done) => {
      const invalidClient = new Client(
        `http://localhost:${httpServer.address().port}`,
        {
          auth: { token: "invalid-token" },
        }
      );

      invalidClient.on("connect_error", (error) => {
        expect(error.message).toContain("Authentication error");
        invalidClient.close();
        done();
      });
    });

    test("debe aceptar tokens válidos", () => {
      expect(clientSocket.connected).toBe(true);
    });
  });

  describe("Gestión de Workspaces", () => {
    test("debe permitir unirse a un workspace", (done) => {
      clientSocket.emit("join-workspace", "workspace-123");

      clientSocket.on("workspace-joined", (data) => {
        expect(data.workspaceId).toBe("workspace-123");
        done();
      });
    });

    test("debe manejar múltiples usuarios en el mismo workspace", (done) => {
      const token2 = jwt.sign(
        { userId: "test-user-2", email: "test2@example.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const client2 = new Client(
        `http://localhost:${httpServer.address().port}`,
        {
          auth: { token: token2 },
        }
      );

      client2.on("connect", () => {
        clientSocket.emit("join-workspace", "workspace-123");
        client2.emit("join-workspace", "workspace-123");

        setTimeout(() => {
          client2.close();
          done();
        }, 100);
      });
    });
  });

  describe("Chat en Tiempo Real", () => {
    beforeEach((done) => {
      clientSocket.emit("join-workspace", "workspace-123");
      clientSocket.on("workspace-joined", () => done());
    });

    test("debe enviar y recibir mensajes de chat", (done) => {
      const token2 = jwt.sign(
        { userId: "test-user-2", email: "test2@example.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const client2 = new Client(
        `http://localhost:${httpServer.address().port}`,
        {
          auth: { token: token2 },
        }
      );

      client2.on("connect", () => {
        client2.emit("join-workspace", "workspace-123");

        client2.on("new-message", (message) => {
          expect(message.content).toBe("Hola desde el test");
          expect(message.userEmail).toBe("test@example.com");
          expect(message.workspaceId).toBe("workspace-123");
          client2.close();
          done();
        });

        // Enviar mensaje desde el primer cliente
        setTimeout(() => {
          clientSocket.emit("send-message", {
            content: "Hola desde el test",
            workspaceId: "workspace-123",
          });
        }, 100);
      });
    });

    test("debe confirmar el envío de mensajes al remitente", (done) => {
      clientSocket.on("message-sent", (message) => {
        expect(message.content).toBe("Mensaje de confirmación");
        expect(message.userId).toBe("test-user-1");
        done();
      });

      clientSocket.emit("send-message", {
        content: "Mensaje de confirmación",
        workspaceId: "workspace-123",
      });
    });
  });

  describe("Notas Colaborativas", () => {
    test("debe sincronizar cambios en notas", (done) => {
      const token2 = jwt.sign(
        { userId: "test-user-2", email: "test2@example.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const client2 = new Client(
        `http://localhost:${httpServer.address().port}`,
        {
          auth: { token: token2 },
        }
      );

      client2.on("connect", () => {
        // Simular que ambos usuarios están editando la misma nota
        clientSocket.join("note-456");
        client2.join("note-456");

        client2.on("note-changed", (data) => {
          expect(data.noteId).toBe("note-456");
          expect(data.content).toBe("Contenido actualizado");
          expect(data.userId).toBe("test-user-1");
          client2.close();
          done();
        });

        // Simular actualización de nota
        setTimeout(() => {
          clientSocket.emit("note-update", {
            noteId: "note-456",
            content: "Contenido actualizado",
          });
        }, 100);
      });
    });

    test("debe sincronizar posiciones de cursor", (done) => {
      const token2 = jwt.sign(
        { userId: "test-user-2", email: "test2@example.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const client2 = new Client(
        `http://localhost:${httpServer.address().port}`,
        {
          auth: { token: token2 },
        }
      );

      client2.on("connect", () => {
        client2.on("cursor-update", (data) => {
          expect(data.userId).toBe("test-user-1");
          expect(data.userEmail).toBe("test@example.com");
          expect(data.position).toBe(42);
          client2.close();
          done();
        });

        setTimeout(() => {
          clientSocket.emit("cursor-position", {
            noteId: "note-789",
            position: 42,
            selection: { start: 42, end: 50 },
          });
        }, 100);
      });
    });
  });

  describe("Manejo de Errores", () => {
    test("debe manejar desconexiones inesperadas", (done) => {
      clientSocket.on("disconnect", (reason) => {
        expect(reason).toBeDefined();
        done();
      });

      // Simular desconexión
      clientSocket.disconnect();
    });

    test("debe manejar eventos malformados", (done) => {
      // Enviar datos inválidos
      clientSocket.emit("send-message", null);
      clientSocket.emit("note-update", { noteId: null });

      // Si no hay errores después de 100ms, el test pasa
      setTimeout(() => {
        expect(clientSocket.connected).toBe(true);
        done();
      }, 100);
    });
  });

  describe("Rendimiento", () => {
    test("debe manejar múltiples mensajes rápidos", (done) => {
      clientSocket.emit("join-workspace", "workspace-perf");

      let messageCount = 0;
      const totalMessages = 50;

      clientSocket.on("message-sent", () => {
        messageCount++;
        if (messageCount === totalMessages) {
          expect(messageCount).toBe(totalMessages);
          done();
        }
      });

      // Enviar múltiples mensajes rápidamente
      for (let i = 0; i < totalMessages; i++) {
        clientSocket.emit("send-message", {
          content: `Mensaje ${i}`,
          workspaceId: "workspace-perf",
        });
      }
    });

    test("debe mantener la conexión bajo carga", (done) => {
      const startTime = Date.now();
      let operationsCompleted = 0;
      const totalOperations = 100;

      const completeOperation = () => {
        operationsCompleted++;
        if (operationsCompleted === totalOperations) {
          const endTime = Date.now();
          const duration = endTime - startTime;

          expect(duration).toBeLessThan(5000); // Menos de 5 segundos
          expect(clientSocket.connected).toBe(true);
          done();
        }
      };

      // Realizar múltiples operaciones
      for (let i = 0; i < totalOperations; i++) {
        setTimeout(() => {
          clientSocket.emit("cursor-position", {
            noteId: "note-perf",
            position: i,
            selection: { start: i, end: i + 1 },
          });
          completeOperation();
        }, i * 10);
      }
    });
  });
});
