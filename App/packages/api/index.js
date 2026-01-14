import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { createClient } from 'redis';
import amqp from 'amqplib';

const app = express();
const port = 3000;
const instanceId = process.env.INSTANCE_ID || 'default';

/**
 * REDIS (Pub/Sub for WebSocket scaling)
 */
const publisher = createClient({ url: 'redis://redis:6379' });
const subscriber = createClient({ url: 'redis://redis:6379' });

publisher.on('error', err =>
  console.error(`[Instance ${instanceId}] Redis Publisher Error:`, err)
);
subscriber.on('error', err =>
  console.error(`[Instance ${instanceId}] Redis Subscriber Error:`, err)
);

await publisher.connect();
await subscriber.connect();

/**
 * HTTP + WEBSOCKET SERVER
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  console.log(`[Instance ${instanceId}] WebSocket client connected`);
  ws.on('close', () =>
    console.log(`[Instance ${instanceId}] WebSocket client disconnected`)
  );
});

subscriber.subscribe('item_updates', (message) => {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
});

async function broadcast(data) {
  await publisher.publish('item_updates', JSON.stringify(data));
}

/**
 * MIDDLEWARE
 */
app.use(cors({
  origin: 'http://localhost:8000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());

/**
 * RABBITMQ RPC SETUP
 */
let amqpConnection;
let amqpChannel;

let itemReplyQueue;
let userReplyQueue;

const pendingItemRequests = new Map();
const pendingUserRequests = new Map();

function generateUuid() {
  return Math.random().toString(16).slice(2) + Date.now();
}

async function setupRabbitMQ() {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      amqpConnection = await amqp.connect('amqp://rabbitmq');
      amqpChannel = await amqpConnection.createChannel();

      itemReplyQueue = await amqpChannel.assertQueue('', { exclusive: true });
      userReplyQueue = await amqpChannel.assertQueue('', { exclusive: true });

      amqpChannel.consume(
        itemReplyQueue.queue,
        (msg) => {
          const resolver = pendingItemRequests.get(msg.properties.correlationId);
          if (resolver) {
            resolver(JSON.parse(msg.content.toString()));
            pendingItemRequests.delete(msg.properties.correlationId);
          }
        },
        { noAck: true }
      );

      amqpChannel.consume(
        userReplyQueue.queue,
        (msg) => {
          const resolver = pendingUserRequests.get(msg.properties.correlationId);
          if (resolver) {
            resolver(JSON.parse(msg.content.toString()));
            pendingUserRequests.delete(msg.properties.correlationId);
          }
        },
        { noAck: true }
      );

      console.log(`[Instance ${instanceId}] RabbitMQ connected`);
      return;
    } catch (err) {
      retries++;
      console.error(
        `[Instance ${instanceId}] RabbitMQ connection failed (${retries}/${maxRetries})`,
        err.message
      );
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.error(`[Instance ${instanceId}] RabbitMQ unavailable. Exiting.`);
  process.exit(1);
}

async function sendRpc(queue, replyQueue, pendingMap, command, payload) {
  const correlationId = generateUuid();

  return new Promise((resolve, reject) => {
    pendingMap.set(correlationId, resolve);

    amqpChannel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify({ command, payload })),
      {
        correlationId,
        replyTo: replyQueue.queue,
      }
    );

    setTimeout(() => {
      if (pendingMap.has(correlationId)) {
        pendingMap.delete(correlationId);
        reject(new Error('RPC timeout'));
      }
    }, 5000);
  });
}

const sendUserRpcMessage = (command, payload) =>
  sendRpc('user_requests', userReplyQueue, pendingUserRequests, command, payload);

const sendItemRpcMessage = (command, payload) =>
  sendRpc('item_requests', itemReplyQueue, pendingItemRequests, command, payload);

/**
 * JWT AUTH MIDDLEWARE
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  if (!token) return res.sendStatus(401);

  try {
    const response = await sendUserRpcMessage('verify_token', { token });
    if (response.status === 'success') {
      req.user = response.data.user;
      next();
    } else {
      res.sendStatus(403);
    }
  } catch {
    res.sendStatus(503);
  }
};

/**
 * AUTH ROUTES
 */
app.post('/signup', async (req, res) => {
  try {
    const response = await sendUserRpcMessage('signup', req.body);
    res.status(201).json(response.data);
  } catch (err) {
    res.status(504).send(err.message);
  }
});

app.post('/login', async (req, res) => {
  try {
    const response = await sendUserRpcMessage('login', req.body);
    response.status === 'success'
      ? res.json(response.data)
      : res.status(401).send(response.message);
  } catch (err) {
    res.status(504).send(err.message);
  }
});

/**
 * ITEM ROUTES
 */
app.get('/items', authenticateToken, async (req, res) => {
  try {
    const response = await sendItemRpcMessage('get_items', {});
    res.json(response.data);
  } catch {
    res.status(504).send('Item service timeout');
  }
});

app.post('/items', authenticateToken, async (req, res) => {
  try {
    const response = await sendItemRpcMessage('create_item', {
      ...req.body,
      userEmail: req.user.username,
    });

    await broadcast({ type: 'item_added', item: response.data });
    res.status(201).json(response.data);
  } catch {
    res.status(504).send('Item service timeout');
  }
});

app.put('/items/:id', authenticateToken, async (req, res) => {
  try {
    const response = await sendItemRpcMessage('update_item', {
      id: parseInt(req.params.id),
      ...req.body,
      userEmail: req.user.username,
    });

    if (response.status === 'success') {
      await broadcast({ type: 'item_updated', item: response.data });
      res.json(response.data);
    } else {
      res.status(404).send(response.message);
    }
  } catch {
    res.status(504).send('Item service timeout');
  }
});

/**
 * DELETE ITEM
 */
app.delete('/items/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const response = await sendItemRpcMessage('delete_item', {
      id,
      userEmail: req.user.username,
    });

    if (response.status === 'success') {
      await broadcast({ type: 'item_deleted', id });
      res.sendStatus(204);
    } else {
      res.status(404).send(response.message);
    }
  } catch {
    res.status(504).send('Item service timeout');
  }
});

/**
 * START SERVER
 */
await setupRabbitMQ();

server.listen(port, () => {
  console.log(`[Instance ${instanceId}] API running on port ${port}`);
});
