# Servidor WebSocket Modular

Este proyecto implementa un servidor WebSocket robusto y modular utilizando Socket.IO, con características avanzadas para aplicaciones en tiempo real.

## Características

### Arquitectura

- **Modular**: Código organizado en módulos independientes por funcionalidad
- **Escalabilidad horizontal**: Integración con Redis para compartir estado entre múltiples instancias
- **Autenticación JWT**: Seguridad mejorada para conexiones WebSocket

### Funcionalidades

- **Reconexión inteligente**: Lógica mejorada de reconexión y recuperación de estado
- **Compresión de mensajes**: Reducción del tamaño de los payloads
- **Canales privados**: Salas con autenticación para comunicación segura

### Monitoreo

- **Métricas en tiempo real**: Dashboard para monitorear conexiones y actividad
- **Logging estructurado**: Sistema avanzado de logs para facilitar el debugging

## Estructura del Proyecto

```
src/
├── config/             # Configuración de la aplicación
├── middleware/         # Middleware (autenticación, etc.)
├── modules/            # Módulos funcionales
│   ├── workspace/      # Gestión de workspaces
│   ├── collection/     # Gestión de colecciones
│   ├── chat/           # Sistema de chat
│   └── note/           # Notas colaborativas
├── services/           # Servicios compartidos
│   ├── metrics.js      # Servicio de métricas
│   └── redis.js        # Servicio de Redis
├── utils/              # Utilidades
│   └── logger.js       # Sistema de logging
└── index.js            # Punto de entrada
```

## Requisitos

- Node.js 16+
- Redis (opcional, para escalabilidad horizontal)

## Instalación

1. Instalar dependencias:

   ```
   npm install
   ```

2. Configurar variables de entorno (crear archivo `.env`):

   ```
   PORT=3001
   NODE_ENV=development
   JWT_SECRET=your_jwt_secret_key_here
   REDIS_HOST=localhost
   REDIS_PORT=6379
   LOG_LEVEL=info
   ```

3. Iniciar el servidor:

   ```
   npm start
   ```

   Para desarrollo con recarga automática:

   ```
   npm run dev
   ```

## Endpoints

- **WebSocket**: `ws://localhost:3001`
- **Estado del servidor**: `http://localhost:3001/health`
- **Métricas**: `http://localhost:3001/metrics`

## Eventos WebSocket

### Workspace

- `join_workspace`: Unirse a un workspace
- `leave_workspace`: Salir de un workspace
- `get_workspace_users`: Obtener usuarios conectados a un workspace

### Colecciones

- `join_collection`: Unirse a una colección
- `leave_collection`: Salir de una colección
- `get_collections_users`: Obtener usuarios en todas las colecciones

### Chat

- `new_message`: Enviar un nuevo mensaje
- `user_typing`: Indicar que un usuario está escribiendo
- `user_stop_typing`: Indicar que un usuario dejó de escribir

### Notas

- `join_note`: Unirse a una nota colaborativa
- `leave_note`: Salir de una nota
- `cursor_update`: Actualizar posición del cursor
- `note_content_update`: Actualizar contenido de la nota

### Tareas/Agenda

- `join_agenda`: Unirse a la vista de agenda
- `leave_agenda`: Salir de la vista de agenda
- `get_agenda_users`: Obtener usuarios conectados en la agenda
- `task_created`: Notificar creación de nueva tarea
- `task_updated`: Notificar actualización de tarea
- `task_deleted`: Notificar eliminación de tarea
- `task_moved`: Notificar movimiento de tarea entre estados

## Escalabilidad Horizontal

Para habilitar la escalabilidad horizontal:

1. Asegúrate de tener Redis instalado y configurado
2. Configura las variables de entorno `REDIS_HOST` y `REDIS_PORT`
3. Inicia múltiples instancias del servidor en diferentes puertos
4. Utiliza un balanceador de carga (como Nginx) para distribuir el tráfico

## Monitoreo

Accede a las métricas en tiempo real en `http://localhost:3001/metrics`. En producción, esta ruta está protegida y requiere autenticación.

## Seguridad

En producción, todas las conexiones WebSocket requieren autenticación JWT. El token debe enviarse en el handshake:

```javascript
const socket = io("http://localhost:3001", {
  auth: {
    token: "your-jwt-token",
  },
});
```

## Licencia

ISC
