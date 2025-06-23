/**
 * Tests unitarios para handlers WebSocket
 * Valida la lógica de negocio de los handlers sin depender de conexiones reales
 */

// Importar handlers reales
const ChatHandler = require("../src/modules/chat/chat.handler");
const WorkspaceHandler = require("../src/modules/workspace/workspace.handler");
const NoteHandler = require("../src/modules/note/note.handler");
const CollectionHandler = require("../src/modules/collection/collection.handler");

// Mock de servicios para evitar dependencias externas
jest.mock("../src/services/redis", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(true),
  exists: jest.fn().mockResolvedValue(false),
  initialize: jest.fn().mockResolvedValue(true),
  healthCheck: jest.fn().mockResolvedValue({ status: "healthy" }),
}));

jest.mock("../src/services/metrics", () => ({
  connectionCreated: jest.fn(),
  connectionClosed: jest.fn(),
  messageProcessed: jest.fn(),
  errorOccurred: jest.fn(),
  getMetricsSummary: jest.fn().mockReturnValue({}),
  userJoinedWorkspace: jest.fn(),
  userLeftWorkspace: jest.fn(),
}));

jest.mock("../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const redisService = require("../src/services/redis");
const metricsService = require("../src/services/metrics");

describe("WebSocket Handlers Unit Tests", () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock del servidor Socket.IO
    mockIo = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
      emit: jest.fn(),
    };

    // Mock del socket individual
    mockSocket = {
      id: "test-socket-id",
      user: {
        id: "test-user-1",
        email: "test@example.com",
        name: "Test User",
      },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
      on: jest.fn(),
    };
  });

  describe("ChatHandler", () => {
    let chatHandler;

    beforeEach(() => {
      chatHandler = new ChatHandler(mockIo);
    });

    describe("registerHandlers", () => {
      test("debe registrar todos los handlers de eventos", () => {
        chatHandler.registerHandlers(mockSocket);

        expect(mockSocket.on).toHaveBeenCalledWith(
          "new_message",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "user_typing",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "user_stop_typing",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledTimes(3);
      });
    });

    describe("handleNewMessage", () => {
      test("debe procesar un mensaje válido correctamente", async () => {
        const messageData = {
          workspaceId: "workspace-123",
          senderEmail: "test@example.com",
          senderName: "Test User",
          content: "Hello world",
        };

        await chatHandler.handleNewMessage(mockSocket, messageData);

        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith("workspace-123");
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "new_message",
          expect.any(Object)
        );
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "new_message",
          expect.any(Number)
        );
      });

      test("debe rechazar mensajes con datos incompletos", async () => {
        const invalidMessageData = {
          workspaceId: "workspace-123",
          senderEmail: "test@example.com",
          // Falta content
        };

        await chatHandler.handleNewMessage(mockSocket, invalidMessageData);

        expect(mockSocket.emit).toHaveBeenCalledWith(
          "error",
          expect.objectContaining({ message: "Datos de mensaje incompletos" })
        );
        expect(redisService.set).not.toHaveBeenCalled();
      });

      test("debe manejar errores de Redis gracefully", async () => {
        redisService.set.mockRejectedValueOnce(new Error("Redis error"));

        const messageData = {
          workspaceId: "workspace-123",
          senderEmail: "test@example.com",
          senderName: "Test User",
          content: "Hello world",
        };

        await chatHandler.handleNewMessage(mockSocket, messageData);

        expect(metricsService.errorOccurred).toHaveBeenCalledWith(
          "new_message",
          expect.objectContaining({ error: "Redis error" })
        );
        expect(mockSocket.emit).toHaveBeenCalledWith(
          "error",
          expect.any(Object)
        );
      });
    });

    describe("handleUserTyping", () => {
      test("debe manejar evento de usuario escribiendo", async () => {
        const typingData = {
          workspaceId: "workspace-123",
          email: "test@example.com",
          name: "Test User",
        };

        await chatHandler.handleUserTyping(mockSocket, typingData);

        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith("workspace-123");
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "user_typing",
          expect.objectContaining({
            email: "test@example.com",
            name: "Test User",
          })
        );
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "user_typing"
        );
      });

      test("debe ignorar datos incompletos sin fallar", async () => {
        const invalidData = { workspaceId: "workspace-123" }; // Falta email

        await chatHandler.handleUserTyping(mockSocket, invalidData);

        expect(redisService.set).not.toHaveBeenCalled();
        expect(mockIo.to).not.toHaveBeenCalled();
      });
    });

    describe("handleUserStopTyping", () => {
      test("debe manejar evento de usuario que deja de escribir", async () => {
        const typingData = {
          workspaceId: "workspace-123",
          email: "test@example.com",
          name: "Test User",
        };

        await chatHandler.handleUserStopTyping(mockSocket, typingData);

        expect(redisService.get).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith("workspace-123");
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "user_stop_typing",
          expect.objectContaining({ email: "test@example.com" })
        );
      });
    });
  });

  describe("WorkspaceHandler", () => {
    let workspaceHandler;

    beforeEach(() => {
      workspaceHandler = new WorkspaceHandler(mockIo);
    });

    describe("registerHandlers", () => {
      test("debe registrar todos los handlers de eventos", () => {
        workspaceHandler.registerHandlers(mockSocket);

        expect(mockSocket.on).toHaveBeenCalledWith(
          "join_workspace",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "leave_workspace",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "get_workspace_users",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledTimes(3);
      });
    });

    describe("handleJoinWorkspace", () => {
      test("debe permitir unirse a un workspace", async () => {
        const workspaceId = "workspace-123";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };

        redisService.get.mockResolvedValueOnce({});

        await workspaceHandler.handleJoinWorkspace(
          mockSocket,
          workspaceId,
          userData
        );

        expect(mockSocket.join).toHaveBeenCalledWith(workspaceId);
        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith(workspaceId);
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "users_connected",
          expect.any(Array)
        );
        expect(mockIo.to().emit).toHaveBeenCalledWith("user_joined", userData);
        expect(metricsService.userJoinedWorkspace).toHaveBeenCalledWith(
          workspaceId,
          userData.id
        );
      });

      test("debe manejar errores al unirse al workspace", async () => {
        redisService.set.mockRejectedValueOnce(new Error("Redis error"));

        const workspaceId = "workspace-123";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };

        await workspaceHandler.handleJoinWorkspace(
          mockSocket,
          workspaceId,
          userData
        );

        expect(metricsService.errorOccurred).toHaveBeenCalledWith(
          "join_workspace",
          expect.objectContaining({ error: "Redis error" })
        );
        expect(mockSocket.emit).toHaveBeenCalledWith(
          "error",
          expect.any(Object)
        );
      });
    });

    describe("handleLeaveWorkspace", () => {
      test("debe permitir salir de un workspace", async () => {
        const workspaceId = "workspace-123";

        redisService.get.mockResolvedValueOnce({
          "test-socket-id": {
            id: "user-1",
            email: "test@example.com",
            name: "Test User",
          },
        });

        await workspaceHandler.handleLeaveWorkspace(mockSocket, workspaceId);

        expect(mockSocket.leave).toHaveBeenCalledWith(workspaceId);
        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith(workspaceId);
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "user_left",
          expect.any(Object)
        );
        expect(metricsService.userLeftWorkspace).toHaveBeenCalled();
      });
    });

    describe("handleGetWorkspaceUsers", () => {
      test("debe retornar usuarios conectados al workspace", async () => {
        const workspaceId = "workspace-123";
        const mockUsers = {
          "socket-1": { id: "user-1", email: "user1@example.com" },
          "socket-2": { id: "user-2", email: "user2@example.com" },
        };

        redisService.get.mockResolvedValueOnce(mockUsers);

        await workspaceHandler.handleGetWorkspaceUsers(mockSocket, workspaceId);

        expect(redisService.get).toHaveBeenCalledWith(
          "workspace:workspace-123:users"
        );
        expect(mockSocket.emit).toHaveBeenCalledWith(
          "users_connected",
          Object.values(mockUsers)
        );
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "get_workspace_users",
          expect.any(Number)
        );
      });
    });
  });

  describe("NoteHandler", () => {
    let noteHandler;

    beforeEach(() => {
      noteHandler = new NoteHandler(mockIo);
    });

    describe("registerHandlers", () => {
      test("debe registrar todos los handlers de eventos", () => {
        noteHandler.registerHandlers(mockSocket);

        expect(mockSocket.on).toHaveBeenCalledWith(
          "join_note",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "leave_note",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "cursor_update",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "note_content_update",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledTimes(4);
      });
    });

    describe("handleJoinNote", () => {
      test("debe permitir unirse a una nota", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };

        redisService.get.mockResolvedValueOnce(null); // No content in Redis

        await noteHandler.handleJoinNote(
          mockSocket,
          workspaceId,
          noteId,
          userData
        );

        expect(mockSocket.join).toHaveBeenCalledWith(
          `note:${workspaceId}:${noteId}`
        );
        expect(redisService.set).toHaveBeenCalled();
        expect(mockSocket.emit).toHaveBeenCalledWith(
          "note_content_loaded",
          expect.objectContaining({ noteId, content: "" })
        );
        expect(mockIo.to).toHaveBeenCalledWith(`note:${workspaceId}:${noteId}`);
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "join_note",
          expect.any(Number)
        );
      });

      test("debe cargar contenido existente de la nota", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };
        const existingContent = "Contenido existente de la nota";

        redisService.get.mockResolvedValueOnce(existingContent);

        await noteHandler.handleJoinNote(
          mockSocket,
          workspaceId,
          noteId,
          userData
        );

        expect(mockSocket.emit).toHaveBeenCalledWith(
          "note_content_loaded",
          expect.objectContaining({ noteId, content: existingContent })
        );
      });
    });

    describe("handleLeaveNote", () => {
      test("debe permitir salir de una nota", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";

        await noteHandler.handleLeaveNote(mockSocket, workspaceId, noteId);

        expect(mockSocket.leave).toHaveBeenCalledWith(
          `note:${workspaceId}:${noteId}`
        );
        expect(redisService.set).toHaveBeenCalled();
      });
    });

    describe("handleContentUpdate", () => {
      test("debe actualizar el contenido de una nota", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";
        const content = "Nuevo contenido de la nota";

        await noteHandler.handleContentUpdate(
          mockSocket,
          workspaceId,
          noteId,
          content
        );

        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith(`note:${workspaceId}:${noteId}`);
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "note_content_updated",
          expect.objectContaining({ noteId, content })
        );
      });

      test("debe rechazar actualizaciones sin contenido", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";

        await noteHandler.handleContentUpdate(
          mockSocket,
          workspaceId,
          noteId,
          null
        );

        expect(mockSocket.emit).toHaveBeenCalledWith(
          "error",
          expect.objectContaining({ message: "Contenido de nota requerido" })
        );
        expect(redisService.set).not.toHaveBeenCalled();
      });
    });

    describe("handleCursorUpdate", () => {
      test("debe actualizar la posición del cursor", async () => {
        const workspaceId = "workspace-123";
        const noteId = "note-456";
        const cursorData = {
          position: 42,
          selection: { start: 42, end: 50 },
        };

        await noteHandler.handleCursorUpdate(
          mockSocket,
          workspaceId,
          noteId,
          cursorData
        );

        expect(mockIo.to).toHaveBeenCalledWith(`note:${workspaceId}:${noteId}`);
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "cursor_updated",
          expect.objectContaining({
            noteId,
            userId: mockSocket.id,
            cursor: cursorData,
          })
        );
      });
    });
  });

  describe("CollectionHandler", () => {
    let collectionHandler;

    beforeEach(() => {
      collectionHandler = new CollectionHandler(mockIo);
    });

    describe("registerHandlers", () => {
      test("debe registrar todos los handlers de eventos", () => {
        collectionHandler.registerHandlers(mockSocket);

        expect(mockSocket.on).toHaveBeenCalledWith(
          "join_collection",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "leave_collection",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledWith(
          "get_collections_users",
          expect.any(Function)
        );
        expect(mockSocket.on).toHaveBeenCalledTimes(3);
      });
    });

    describe("handleJoinCollection", () => {
      test("debe permitir unirse a una colección", async () => {
        const workspaceId = "workspace-123";
        const collectionId = "collection-456";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };

        redisService.get.mockResolvedValueOnce({});

        await collectionHandler.handleJoinCollection(
          mockSocket,
          workspaceId,
          collectionId,
          userData
        );

        expect(mockSocket.join).toHaveBeenCalledWith(
          `${workspaceId}:${collectionId}`
        );
        expect(redisService.set).toHaveBeenCalled();
        expect(mockIo.to).toHaveBeenCalledWith(workspaceId);
        expect(mockIo.to().emit).toHaveBeenCalledWith(
          "collection_user_joined",
          expect.objectContaining({ collectionId, userData })
        );
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "join_collection",
          expect.any(Number)
        );
      });

      test("debe manejar errores al unirse a la colección", async () => {
        redisService.set.mockRejectedValueOnce(new Error("Redis error"));

        const workspaceId = "workspace-123";
        const collectionId = "collection-456";
        const userData = {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
        };

        await collectionHandler.handleJoinCollection(
          mockSocket,
          workspaceId,
          collectionId,
          userData
        );

        expect(metricsService.errorOccurred).toHaveBeenCalledWith(
          "join_collection",
          expect.objectContaining({ error: "Redis error" })
        );
        expect(mockSocket.emit).toHaveBeenCalledWith(
          "error",
          expect.any(Object)
        );
      });
    });

    describe("handleLeaveCollection", () => {
      test("debe permitir salir de una colección", async () => {
        const workspaceId = "workspace-123";
        const collectionId = "collection-456";

        redisService.get.mockResolvedValueOnce({
          "test-socket-id": {
            id: "user-1",
            email: "test@example.com",
            name: "Test User",
          },
        });

        await collectionHandler.handleLeaveCollection(
          mockSocket,
          workspaceId,
          collectionId
        );

        expect(redisService.set).toHaveBeenCalled();
        expect(mockSocket.leave).toHaveBeenCalledWith(
          `${workspaceId}:${collectionId}`
        );
        expect(mockIo.to).toHaveBeenCalledWith(workspaceId);
      });
    });

    describe("handleGetCollectionsUsers", () => {
      test("debe retornar usuarios en las colecciones", async () => {
        const workspaceId = "workspace-123";

        await collectionHandler.handleGetCollectionsUsers(
          mockSocket,
          workspaceId
        );

        expect(mockSocket.emit).toHaveBeenCalledWith(
          "collections_users_updated",
          expect.any(Object)
        );
        expect(metricsService.messageProcessed).toHaveBeenCalledWith(
          "get_collections_users",
          expect.any(Number)
        );
      });
    });
  });

  describe("Error Handling", () => {
    test("ChatHandler debe manejar errores de Redis", async () => {
      const chatHandler = new ChatHandler(mockIo);
      redisService.get.mockRejectedValueOnce(
        new Error("Redis connection failed")
      );

      const messageData = {
        workspaceId: "workspace-123",
        senderEmail: "test@example.com",
        senderName: "Test User",
        content: "Hello world",
      };

      await chatHandler.handleNewMessage(mockSocket, messageData);

      expect(metricsService.errorOccurred).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith("error", expect.any(Object));
    });

    test("WorkspaceHandler debe manejar errores de Redis", async () => {
      const workspaceHandler = new WorkspaceHandler(mockIo);
      redisService.get.mockRejectedValueOnce(
        new Error("Redis connection failed")
      );

      await workspaceHandler.handleGetWorkspaceUsers(
        mockSocket,
        "workspace-123"
      );

      expect(metricsService.errorOccurred).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith("error", expect.any(Object));
    });

    test("NoteHandler debe manejar errores de Redis", async () => {
      const noteHandler = new NoteHandler(mockIo);
      redisService.set.mockRejectedValueOnce(
        new Error("Redis connection failed")
      );

      const workspaceId = "workspace-123";
      const noteId = "note-456";
      const userData = {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
      };

      await noteHandler.handleJoinNote(
        mockSocket,
        workspaceId,
        noteId,
        userData
      );

      expect(metricsService.errorOccurred).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith("error", expect.any(Object));
    });

    test("CollectionHandler debe manejar errores de Redis", async () => {
      const collectionHandler = new CollectionHandler(mockIo);
      redisService.set.mockRejectedValueOnce(
        new Error("Redis connection failed")
      );

      const workspaceId = "workspace-123";
      const collectionId = "collection-456";
      const userData = {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
      };

      await collectionHandler.handleJoinCollection(
        mockSocket,
        workspaceId,
        collectionId,
        userData
      );

      expect(metricsService.errorOccurred).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith("error", expect.any(Object));
    });
  });

  describe("Performance", () => {
    test("debe procesar múltiples mensajes eficientemente", async () => {
      const chatHandler = new ChatHandler(mockIo);
      const messageCount = 10;
      const startTime = Date.now();

      const promises = [];
      for (let i = 0; i < messageCount; i++) {
        const messageData = {
          workspaceId: "workspace-perf",
          senderEmail: "test@example.com",
          senderName: "Test User",
          content: `Message ${i}`,
        };
        promises.push(chatHandler.handleNewMessage(mockSocket, messageData));
      }

      await Promise.all(promises);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Menos de 1 segundo
      expect(redisService.set).toHaveBeenCalledTimes(messageCount);
      expect(metricsService.messageProcessed).toHaveBeenCalledTimes(
        messageCount
      );
    });

    test("debe manejar múltiples operaciones de workspace", async () => {
      const workspaceHandler = new WorkspaceHandler(mockIo);
      const operationCount = 5;

      redisService.get.mockResolvedValue({});

      const promises = [];
      for (let i = 0; i < operationCount; i++) {
        const userData = {
          id: `user-${i}`,
          email: `user${i}@example.com`,
          name: `User ${i}`,
        };
        promises.push(
          workspaceHandler.handleJoinWorkspace(
            mockSocket,
            "workspace-perf",
            userData
          )
        );
      }

      await Promise.all(promises);

      expect(redisService.set).toHaveBeenCalledTimes(operationCount);
      expect(metricsService.userJoinedWorkspace).toHaveBeenCalledTimes(
        operationCount
      );
    });

    test("debe manejar múltiples actualizaciones de nota eficientemente", async () => {
      const noteHandler = new NoteHandler(mockIo);
      const updateCount = 10;

      const promises = [];
      for (let i = 0; i < updateCount; i++) {
        promises.push(
          noteHandler.handleContentUpdate(
            mockSocket,
            "workspace-perf",
            "note-perf",
            `Content update ${i}`
          )
        );
      }

      await Promise.all(promises);

      expect(redisService.set).toHaveBeenCalledTimes(updateCount);
      expect(mockIo.to).toHaveBeenCalledTimes(updateCount);
    });
  });

  describe("Integration Tests", () => {
    test("debe manejar flujo completo de chat en workspace", async () => {
      const workspaceHandler = new WorkspaceHandler(mockIo);
      const chatHandler = new ChatHandler(mockIo);

      const workspaceId = "workspace-integration";
      const userData = {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
      };

      redisService.get.mockResolvedValue({});

      // Usuario se une al workspace
      await workspaceHandler.handleJoinWorkspace(
        mockSocket,
        workspaceId,
        userData
      );

      // Usuario envía mensaje
      const messageData = {
        workspaceId,
        senderEmail: userData.email,
        senderName: userData.name,
        content: "Hello from integration test",
      };

      await chatHandler.handleNewMessage(mockSocket, messageData);

      // Verificar que ambas operaciones funcionaron
      expect(mockSocket.join).toHaveBeenCalledWith(workspaceId);
      expect(mockIo.to).toHaveBeenCalledWith(workspaceId);
      expect(redisService.set).toHaveBeenCalledTimes(2); // Workspace users + message
    });

    test("debe manejar flujo completo de edición colaborativa", async () => {
      const workspaceHandler = new WorkspaceHandler(mockIo);
      const noteHandler = new NoteHandler(mockIo);

      const workspaceId = "workspace-collab";
      const noteId = "note-collab";
      const userData = {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
      };

      redisService.get.mockResolvedValue({});

      // Usuario se une al workspace
      await workspaceHandler.handleJoinWorkspace(
        mockSocket,
        workspaceId,
        userData
      );

      // Usuario se une a la nota
      await noteHandler.handleJoinNote(
        mockSocket,
        workspaceId,
        noteId,
        userData
      );

      // Usuario actualiza contenido
      await noteHandler.handleContentUpdate(
        mockSocket,
        workspaceId,
        noteId,
        "Collaborative content"
      );

      // Usuario actualiza cursor
      await noteHandler.handleCursorUpdate(mockSocket, workspaceId, noteId, {
        position: 10,
      });

      // Verificar flujo completo
      expect(mockSocket.join).toHaveBeenCalledWith(workspaceId);
      expect(mockSocket.join).toHaveBeenCalledWith(
        `note:${workspaceId}:${noteId}`
      );
      expect(mockIo.to).toHaveBeenCalledWith(`note:${workspaceId}:${noteId}`);
    });
  });
});
