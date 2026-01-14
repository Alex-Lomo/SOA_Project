import pg from 'pg';
import amqp from 'amqplib';
import { Kafka } from 'kafkajs';

const { Pool } = pg;
const instanceId = process.env.INSTANCE_ID || 'item-service-default';

console.log(`[Item Service ${instanceId}] Starting item service...`);

const pool = new Pool({
  user: process.env.POSTGRES_USER || 'user',
  host: process.env.POSTGRES_HOST || 'db',
  database: process.env.POSTGRES_DB || 'shopping_db',
  password: process.env.POSTGRES_PASSWORD || 'password',
  port: 5432,
});

const kafka = new Kafka({
  clientId: 'item-service',
  brokers: [process.env.KAFKA_BROKER || 'kafka:9092'],
});

const producer = kafka.producer();

/**
 * DATABASE INITIALIZATION
 */
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        bought BOOLEAN NOT NULL DEFAULT FALSE,
        updated TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log(`[Item Service ${instanceId}] Database initialized successfully.`);
  } catch (err) {
    console.error(`[Item Service ${instanceId}] Error initializing database:`, err);
    process.exit(1);
  }
}

/**
 * RABBITMQ REQUEST HANDLER
 */
async function handleRequest(msg, channel) {
  const { command, payload } = JSON.parse(msg.content.toString());
  const { correlationId, replyTo } = msg.properties;

  console.log(
    `[Item Service ${instanceId}] Received command: ${command}`,
    payload
  );

  let response;

  try {
    switch (command) {
      case 'get_items': {
        const result = await pool.query(
          'SELECT * FROM items ORDER BY id ASC'
        );
        response = { status: 'success', data: result.rows };
        break;
      }

      case 'create_item': {
        const result = await pool.query(
          `INSERT INTO items (name, description, price, quantity, bought)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *;`,
          [
            payload.name,
            payload.description,
            payload.price,
            payload.quantity ?? 1,
            payload.bought ?? false,
          ]
        );

        const newItem = result.rows[0];
        response = { status: 'success', data: newItem };

        await producer.send({
          topic: 'item-created',
          messages: [
            {
              value: JSON.stringify({
                ...newItem,
                userEmail: payload.userEmail,
              }),
            },
          ],
        });
        break;
      }

      case 'update_item': {
        const result = await pool.query(
          `UPDATE items
           SET
             name = COALESCE($1, name),
             description = COALESCE($2, description),
             price = COALESCE($3, price),
             quantity = COALESCE($4, quantity),
             bought = COALESCE($5, bought),
             updated = NOW()
           WHERE id = $6
           RETURNING *;`,
          [
            payload.name,
            payload.description,
            payload.price,
            payload.quantity,
            payload.bought,
            payload.id,
          ]
        );

        if (result.rows.length === 0) {
          response = { status: 'error', message: 'Item not found' };
        } else {
          const updatedItem = result.rows[0];
          response = { status: 'success', data: updatedItem };

          await producer.send({
            topic: 'item-updated',
            messages: [
              {
                value: JSON.stringify({
                  ...updatedItem,
                  userEmail: payload.userEmail,
                }),
              },
            ],
          });
        }
        break;
      }

      case 'delete_item': {
        const result = await pool.query(
          'DELETE FROM items WHERE id = $1 RETURNING id;',
          [payload.id]
        );

        if (result.rows.length === 0) {
          response = { status: 'error', message: 'Item not found' };
        } else {
          response = { status: 'success' };
        }
        break;
      }

      default:
        response = { status: 'error', message: 'Unknown command' };
    }
  } catch (err) {
    console.error(
      `[Item Service ${instanceId}] Error processing command ${command}:`,
      err
    );
    response = { status: 'error', message: err.message };
  }

  channel.sendToQueue(
    replyTo,
    Buffer.from(JSON.stringify(response)),
    { correlationId }
  );
  channel.ack(msg);
}

/**
 * SERVICE STARTUP
 */
async function startItemService() {
  await initializeDatabase();
  await producer.connect();

  const maxRetries = 10;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const connection = await amqp.connect('amqp://rabbitmq');
      const channel = await connection.createChannel();

      await channel.assertQueue('item_requests', { durable: false });
      channel.prefetch(1);

      console.log(
        `[Item Service ${instanceId}] Waiting for messages in item_requests queue.`
      );

      channel.consume(
        'item_requests',
        (msg) => handleRequest(msg, channel),
        { noAck: false }
      );

      return;
    } catch (error) {
      retries++;
      console.error(
        `[Item Service ${instanceId}] RabbitMQ connection failed (${retries}/${maxRetries}):`,
        error.message
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.error(
    `[Item Service ${instanceId}] Could not connect to RabbitMQ. Exiting.`
  );
  process.exit(1);
}

startItemService();
