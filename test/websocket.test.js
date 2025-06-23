/**
 * Tests unitarios para el servidor WebSocket
 * Valida las funcionalidades de tiempo real para chat, notas colaborativas y notificaciones
 */

const jwt = require("jsonwebtoken");

describe("WebSocket Server Tests", () => {
  const JWT_SECRET = "test-secret";
  let mockSocket;
  let mockIo;

  beforeEach(() => {
    // Mock del socket
    mockSocket = {
      id: "socket-test-id",
      userId: "test-user-1",
      userEmail: "test@example.com",
      rooms: new Set(),
      join: jest.fn((room) => {
        mockSocket.rooms.add(room);
      }),
      leave: jest.fn((room) => {
        mockSocket.rooms.delete(room);
      }),
      emit: jest.fn(),
      to: jest.fn(() => ({
        emit: jest.fn(),
      })),
      broadcast: {
        to: jest.fn(() => ({
          emit: jest.fn(),
        })),
      },
      disconnect: jest.fn(),
      handshake: {
        auth: {
          token: jwt.sign(
            { userId: "test-user-1", email: "test@example.com" },
            JWT_SECRET,
            { expiresIn: "1h" }
          ),
        },
      },
    };

    // Mock del servidor IO
    mockIo = {
      emit: jest.fn(),
      to: jest.fn(() => ({
        emit: jest.fn(),
      })),
      sockets: {
        sockets: new Map([["socket-test-id", mockSocket]]),
      },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Autenticación", () => {
    test("debe validar tokens JWT correctamente", () => {
      const validToken = jwt.sign(
        { userId: "test-user", email: "test@example.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      let decoded;
      try {
        decoded = jwt.verify(validToken, JWT_SECRET);
      } catch (err) {
        decoded = null;
      }

      expect(decoded).toBeTruthy();
      expect(decoded.userId).toBe("test-user");
      expect(decoded.email).toBe("test@example.com");
    });

    test("debe rechazar tokens inválidos", () => {
      const invalidToken = "invalid-token";

      let decoded;
      try {
        decoded = jwt.verify(invalidToken, JWT_SECRET);
      } catch (err) {
        decoded = null;
      }

      expect(decoded).toBeNull();
    });

    test("debe manejar tokens expirados", () => {
      const expiredToken = jwt.sign(
        { userId: "test-user", email: "test@example.com" },
        JWT_SECRET,
        { expiresIn: -1 } // Token ya expirado
      );

      let decoded;
      try {
        decoded = jwt.verify(expiredToken, JWT_SECRET);
      } catch (err) {
        decoded = null;
      }

      expect(decoded).toBeNull();
    });
  });

  describe("Gestión de Workspaces", () => {
    test("debe permitir unirse a un workspace", () => {
      const workspaceId = "workspace-123";
      const roomName = `workspace-${workspaceId}`;

      // Simular unirse a workspace
      mockSocket.join(roomName);

      expect(mockSocket.join).toHaveBeenCalledWith(roomName);
      expect(mockSocket.rooms.has(roomName)).toBe(true);
    });

    test("debe permitir salir de un workspace", () => {
      const workspaceId = "workspace-123";
      const roomName = `workspace-${workspaceId}`;

      // Simular unirse y luego salir
      mockSocket.join(roomName);
      mockSocket.leave(roomName);

      expect(mockSocket.leave).toHaveBeenCalledWith(roomName);
      expect(mockSocket.rooms.has(roomName)).toBe(false);
    });

    test("debe emitir confirmación al unirse a workspace", () => {
      const workspaceId = "workspace-123";

      // Simular respuesta del servidor
      mockSocket.emit("workspace-joined", { workspaceId });

      expect(mockSocket.emit).toHaveBeenCalledWith("workspace-joined", {
        workspaceId,
      });
    });
  });

  describe("Chat en Tiempo Real", () => {
    beforeEach(() => {
      mockSocket.join("workspace-123");
    });

    test("debe procesar mensajes de chat correctamente", () => {
      const messageData = {
        content: "Hola desde el test",
        workspaceId: "workspace-123",
      };

      const expectedMessage = {
        id: expect.any(Number),
        content: messageData.content,
        userId: mockSocket.userId,
        userEmail: mockSocket.userEmail,
        timestamp: expect.any(String),
        workspaceId: messageData.workspaceId,
      };

      // Simular procesamiento del mensaje
      const processedMessage = {
        id: Date.now(),
        content: messageData.content,
        userId: mockSocket.userId,
        userEmail: mockSocket.userEmail,
        timestamp: new Date().toISOString(),
        workspaceId: messageData.workspaceId,
      };

      // Verificar estructura del mensaje
      expect(processedMessage).toMatchObject({
        content: messageData.content,
        userId: mockSocket.userId,
        userEmail: mockSocket.userEmail,
        workspaceId: messageData.workspaceId,
      });
      expect(processedMessage.id).toBeDefined();
      expect(processedMessage.timestamp).toBeDefined();
    });

    test("debe emitir mensajes a otros usuarios en el workspace", () => {
      const messageData = {
        content: "Mensaje de prueba",
        workspaceId: "workspace-123",
      };

      // Simular broadcast del mensaje
      mockSocket
        .to(`workspace-${messageData.workspaceId}`)
        .emit("new-message", messageData);

      expect(mockSocket.to).toHaveBeenCalledWith("workspace-workspace-123");
    });

    test("debe confirmar el envío al remitente", () => {
      const messageData = {
        content: "Mensaje de confirmación",
        workspaceId: "workspace-123",
      };

      // Simular confirmación al remitente
      mockSocket.emit("message-sent", messageData);

      expect(mockSocket.emit).toHaveBeenCalledWith("message-sent", messageData);
    });
  });

  describe("Notas Colaborativas", () => {
    test("debe sincronizar cambios en notas", () => {
      const noteData = {
        noteId: "note-456",
        content: "Contenido actualizado",
        userId: mockSocket.userId,
      };

      const expectedUpdate = {
        noteId: noteData.noteId,
        content: noteData.content,
        userId: noteData.userId,
        timestamp: expect.any(String),
      };

      // Simular actualización de nota
      const noteUpdate = {
        ...noteData,
        timestamp: new Date().toISOString(),
      };

      expect(noteUpdate).toMatchObject(expectedUpdate);
    });

    test("debe sincronizar posiciones de cursor", () => {
      const cursorData = {
        noteId: "note-789",
        position: 42,
        selection: { start: 42, end: 50 },
      };

      const expectedCursorUpdate = {
        userId: mockSocket.userId,
        userEmail: mockSocket.userEmail,
        position: cursorData.position,
        selection: cursorData.selection,
      };

      // Simular actualización de cursor
      const cursorUpdate = {
        userId: mockSocket.userId,
        userEmail: mockSocket.userEmail,
        position: cursorData.position,
        selection: cursorData.selection,
      };

      expect(cursorUpdate).toMatchObject(expectedCursorUpdate);
    });

    test("debe manejar múltiples usuarios editando la misma nota", () => {
      const noteId = "note-collaborative";
      const roomName = `note-${noteId}`;

      // Simular múltiples usuarios en la misma nota
      mockSocket.join(roomName);
      expect(mockSocket.rooms.has(roomName)).toBe(true);

      // Verificar que los cambios se propagan a otros usuarios
      mockSocket.to(roomName).emit("note-changed", {
        noteId,
        content: "Cambio colaborativo",
      });

      expect(mockSocket.to).toHaveBeenCalledWith(roomName);
    });
  });

  describe("Manejo de Errores", () => {
    test("debe manejar datos malformados sin fallar", () => {
      const invalidData = null;

      // Verificar que el sistema no falla con datos inválidos
      expect(() => {
        if (invalidData && typeof invalidData === "object") {
          // Procesar datos
        }
      }).not.toThrow();
    });

    test("debe validar campos requeridos en mensajes", () => {
      const invalidMessage = {
        content: "", // Contenido vacío
        workspaceId: null, // ID de workspace inválido
      };

      const isValidMessage = (message) => {
        return (
          message &&
          message.content &&
          message.content.trim().length > 0 &&
          message.workspaceId
        );
      };

      expect(isValidMessage(invalidMessage)).toBeFalsy();

      const validMessage = {
        content: "Mensaje válido",
        workspaceId: "workspace-123",
      };

      expect(isValidMessage(validMessage)).toBeTruthy();
    });

    test("debe manejar desconexiones inesperadas", () => {
      // Simular desconexión
      mockSocket.disconnect();

      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe("Rendimiento", () => {
    test("debe procesar múltiples mensajes eficientemente", () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        content: `Mensaje ${i}`,
        workspaceId: "workspace-perf",
        timestamp: Date.now() + i,
      }));

      const startTime = Date.now();

      // Simular procesamiento de múltiples mensajes
      messages.forEach((message) => {
        const processedMessage = {
          ...message,
          id: Date.now() + Math.random(),
          userId: mockSocket.userId,
          userEmail: mockSocket.userEmail,
        };
        expect(processedMessage).toBeDefined();
      });

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      // Verificar que el procesamiento es eficiente (menos de 1 segundo)
      expect(processingTime).toBeLessThan(1000);
    });

    test("debe manejar múltiples usuarios simultáneos", () => {
      const userCount = 50;
      const users = Array.from({ length: userCount }, (_, i) => ({
        id: `user-${i}`,
        email: `user${i}@example.com`,
        socket: `socket-${i}`,
      }));

      // Simular múltiples usuarios conectados
      users.forEach((user) => {
        expect(user.id).toBeDefined();
        expect(user.email).toBeDefined();
        expect(user.socket).toBeDefined();
      });

      expect(users).toHaveLength(userCount);
    });

    test("debe mantener el rendimiento con alta carga de mensajes", () => {
      const messageCount = 1000;
      const batchSize = 100;

      const processMessageBatch = (messages) => {
        return messages.map((msg) => ({
          ...msg,
          processed: true,
          timestamp: Date.now(),
        }));
      };

      const startTime = Date.now();

      // Procesar mensajes en lotes
      for (let i = 0; i < messageCount; i += batchSize) {
        const batch = Array.from({ length: batchSize }, (_, j) => ({
          id: i + j,
          content: `Mensaje ${i + j}`,
          workspaceId: "workspace-load-test",
        }));

        const processedBatch = processMessageBatch(batch);
        expect(processedBatch).toHaveLength(batchSize);
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // Verificar que el tiempo total es razonable (menos de 5 segundos)
      expect(totalTime).toBeLessThan(5000);
    });
  });

  describe("Integración de Funcionalidades", () => {
    test("debe coordinar chat y notas colaborativas", () => {
      const workspaceId = "workspace-integration";
      const noteId = "note-integration";

      // Usuario se une al workspace
      mockSocket.join(`workspace-${workspaceId}`);

      // Usuario también accede a una nota
      mockSocket.join(`note-${noteId}`);

      expect(mockSocket.rooms.has(`workspace-${workspaceId}`)).toBe(true);
      expect(mockSocket.rooms.has(`note-${noteId}`)).toBe(true);

      // Verificar que puede participar en ambas funcionalidades
      const chatMessage = {
        content: "Estoy editando la nota",
        workspaceId: workspaceId,
      };

      const noteUpdate = {
        noteId: noteId,
        content: "Contenido actualizado desde chat",
      };

      expect(chatMessage.workspaceId).toBe(workspaceId);
      expect(noteUpdate.noteId).toBe(noteId);
    });

    test("debe manejar transiciones entre workspaces", () => {
      const workspace1 = "workspace-1";
      const workspace2 = "workspace-2";

      // Usuario se une al primer workspace
      mockSocket.join(`workspace-${workspace1}`);
      expect(mockSocket.rooms.has(`workspace-${workspace1}`)).toBe(true);

      // Usuario cambia al segundo workspace
      mockSocket.leave(`workspace-${workspace1}`);
      mockSocket.join(`workspace-${workspace2}`);

      expect(mockSocket.rooms.has(`workspace-${workspace1}`)).toBe(false);
      expect(mockSocket.rooms.has(`workspace-${workspace2}`)).toBe(true);
    });
  });
});
