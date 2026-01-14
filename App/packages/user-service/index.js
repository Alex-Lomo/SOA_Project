import pg from 'pg';
import amqp from 'amqplib';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';

const { Pool } = pg;
const instanceId = process.env.INSTANCE_ID || 'user-service-default';
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

console.log(`[User Service ${instanceId}] Starting user service...`);

const pool = new Pool({
  user: process.env.POSTGRES_USER || 'user',
  host: process.env.POSTGRES_HOST || 'db',
  database: process.env.POSTGRES_DB || 'shopping_db',
  password: process.env.POSTGRES_PASSWORD || 'password',
  port: 5432,
});

const kafka = new Kafka({
  clientId: 'user-service',
  brokers: [process.env.KAFKA_BROKER || 'kafka:9092'],
});

const producer = kafka.producer();

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL
      );
    `);
    console.log(`[User Service ${instanceId}] Database initialized successfully.`);
  } catch (err) {
    console.error(`[User Service ${instanceId}] Error initializing database:`, err);
    process.exit(1);
  }
}

async function handleRequest(msg, channel) {
  const { command, payload } = JSON.parse(msg.content.toString());
  const { correlationId, replyTo } = msg.properties;
  console.log(`[User Service ${instanceId}] Received command: ${command} with payload:`, payload);

  let response;
  try {
    switch (command) {
      case 'signup':
        const { username, password } = payload;
        const hashedPassword = await bcrypt.hash(password, 10);
        try {
          const result = await pool.query(
            'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id, username;',
            [username, hashedPassword]
          );
          const user = result.rows[0];
          const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
          response = { status: 'success', data: { user: { id: user.id, username: user.username }, token } };

          await producer.send({
            topic: 'user-created',
            messages: [
              { value: JSON.stringify({ email: user.username }) },
            ],
          });

        } catch (err) {
          if (err.code === '23505') { // Unique violation
            response = { status: 'error', message: 'Username already exists' };
          } else {
            throw err;
          }
        }
        break;
      case 'login':
        const { username: loginUsername, password: loginPassword } = payload;
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1;', [loginUsername]);
        const user = userResult.rows[0];

        if (user && (await bcrypt.compare(loginPassword, user.password_hash))) {
          const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
          response = { status: 'success', data: { user: { id: user.id, username: user.username }, token } };
        } else {
          response = { status: 'error', message: 'Invalid credentials' };
        }
        break;
      case 'verify_token':
        const { token: verifyToken } = payload;
        try {
          const decoded = jwt.verify(verifyToken, JWT_SECRET);
          response = { status: 'success', data: { user: decoded } };
        } catch (err) {
          response = { status: 'error', message: 'Invalid or expired token' };
        }
        break;
      default:
        response = { status: 'error', message: 'Unknown command' };
        break;
    }
  } catch (err) {
    console.error(`[User Service ${instanceId}] Error processing command ${command}:`, err);
    response = { status: 'error', message: err.message };
  }

  channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(response)), {
    correlationId: correlationId,
  });
  channel.ack(msg);
}

async function startUserService() {
  await initializeDatabase();
  await producer.connect();

  const maxRetries = 10;
  let retries = 0;
  let connection;
  let channel;

  // Retry for RabbitMQ connection
  while (retries < maxRetries) {
    try {
      connection = await amqp.connect('amqp://rabbitmq');
      channel = await connection.createChannel();
      await channel.assertQueue('user_requests', { durable: false });
      channel.prefetch(1); // Process one message at a time

      console.log(`[User Service ${instanceId}] Waiting for messages in user_requests queue.`);

      channel.consume('user_requests', (msg) => handleRequest(msg, channel), { noAck: false });

      return; // Connection successful, exit loop
    } catch (error) {
      retries++;
      console.error(`[User Service ${instanceId}] Failed to connect to RabbitMQ (attempt ${retries}/${maxRetries}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
    }
  }
  console.error(`[User Service ${instanceId}] Failed to connect to RabbitMQ after ${maxRetries} attempts. Exiting.`);
  process.exit(1);
}

startUserService();
