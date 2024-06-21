const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { availableParallelism } = require('node:os');
const cluster = require('node:cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');
const { truncate } = require('sqlite');
const bodyParser = require('body-parser');

let roomname = 'defaultRoom';

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i
    });
  }
  return setupPrimary();
}


async function main() {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });
    await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT,
      roomname TEXT
    );
  `);

  const app = express();
  app.use(bodyParser.urlencoded({ extended: true }));
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter()
  });

  app.delete('/truncate-messages', async (req, res) => {
    try {
      await db.exec('DELETE FROM messages');
      res.sendStatus(200);
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: 'Failed to truncate chat messages.' });
    }
  });

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  app.post('/myform', (req, res) => {
    res.sendFile(join(__dirname, 'myform.html'));
    // console.log(req.body.username);
    // console.log(req.body.roomname);
    username = req.body.username;
    roomname = req.body.roomname;
    io.emit('updateRoomname', roomname);
  });

  io.on('connection', async (socket) => {
    socket.join(roomname);
    console.log(roomname);
    socket.on('chat message', async (msg, clientOffset, callback) => {
      let result;
      try {
        result = await db.run('INSERT INTO messages (content, client_offset, roomname) VALUES (?, ?, ?)', msg, clientOffset, roomname);
        callback();
    } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
            callback();
        } else {
            console.error(e);
            // Handle other types of errors if needed
            // You can log the error or take appropriate action
        }
    }
      io.to(roomname).emit('chat message', msg, result.lastID);
      callback();
    });

    if (!socket.recovered) {
      try {
        await db.each('SELECT id, content FROM messages WHERE roomname = ? AND id > ?',
            [roomname, socket.handshake.auth.serverOffset || 0],
            (_err, row) => {
                socket.emit('chat message', row.content, row.id);
            }
        );
    } catch (e) {
        // Handle any errors that may occur during message retrieval
        console.error(e);
    }
    }
  });

  // console.log(io.in(roomname).fetchSockets());
  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}

main();