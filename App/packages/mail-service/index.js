const { Kafka } = require('kafkajs');
const nodemailer = require('nodemailer');

const kafka = new Kafka({
  clientId: 'mail-service',
  brokers: [process.env.KAFKA_BROKER || 'kafka:9092'],
});

const consumer = kafka.consumer({ groupId: 'mail-group' });

const transporter = {
  sendMail: async (options) => {
    console.log('[Mail Service] Mock email sent:', {
      to: options.to,
      subject: options.subject,
      text: options.text,
    });
  },
};

const run = async () => {
  await consumer.connect();

  await consumer.subscribe({ topic: 'user-created', fromBeginning: true });
  await consumer.subscribe({ topic: 'item-created', fromBeginning: true });
  await consumer.subscribe({ topic: 'item-updated', fromBeginning: true });

  console.log('[Mail Service] Listening for Kafka events');

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = JSON.parse(message.value.toString());

      console.log(`[Mail Service] Event received: ${topic}`, event);

      let mailOptions = null;

      if (topic === 'user-created') {
        mailOptions = {
          from: '"Shopping List App" <noreply@shoppingapp.com>',
          to: event.email,
          subject: 'Welcome to Shopping List App',
          text: `Hi ${event.email}, welcome to the Shopping List App. You can now create and manage your shopping items.`,
        };
      }

      else if (topic === 'item-created') {
        mailOptions = {
          from: '"Shopping List App" <noreply@shoppingapp.com>',
          to: event.userEmail,
          subject: 'New Item Added',
          text: `A new item has been added. Name: ${event.name}, Description: ${event.description || 'N/A'}, Price: $${event.price}, Quantity: ${event.quantity}, Bought: ${event.bought ? 'Yes' : 'No'}.`,
        };
      }

      else if (topic === 'item-updated') {
        mailOptions = {
          from: '"Shopping List App" <noreply@shoppingapp.com>',
          to: event.userEmail,
          subject: 'Item Updated',
          text: `An item has been updated. Name: ${event.name}, Description: ${event.description || 'N/A'}, Price: $${event.price}, Quantity: ${event.quantity}, Bought: ${event.bought ? 'Yes' : 'No'}.`,
        };
      }

      if (mailOptions) {
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('[Mail Service] Error sending email:', error);
            return;
          }
          console.log('[Mail Service] Email sent:', info.messageId);
          console.log('[Mail Service] Preview URL:', nodemailer.getTestMessageUrl(info));
        });
      }
    },
  });
};

run().catch(err => {
  console.error('[Mail Service] Fatal error:', err);
});
