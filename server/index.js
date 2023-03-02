const express = require('express');
const expressws = require('express-ws');
const path = require('path');
const fs = require('fs/promises');
const net = require('net');
const pty = require('node-pty');
const os = require("os");
const twofactor = require('two-factor');
const qrimage = require('qr-image');

module.exports = class Server {

  constructor(config) {

    this.config = config;
    this.nextSequence = 1;
    this.termMap = {};

    let app = this.app = express();
    expressws(app);

    const appRoot = process.cwd();

    app.use('/xterm', express.static(path.join(appRoot, 'node_modules', 'xterm')));
    app.use('/xterm-addon-attach', express.static(path.join(appRoot, 'node_modules', 'xterm-addon-attach')));
    app.use('/xterm-addon-fit', express.static(path.join(appRoot, 'node_modules', 'xterm-addon-fit')));
    app.use(express.static(path.join(appRoot, 'client')));

    app.ws('/terminals', (socket, request) => {
      let sequence = this.nextSequence++;
      let ip = request.ip;
      console.log(new Date(), 'wTerm#' + sequence + ' connection(' + ip + ') connected.');
      let term = undefined;

      socket.on('message', (message) => {
        if (term) {
          let matches = message.match && message.match(/^wtc:resize\((\d+),(\d+)\);$/);
          if (matches)
            return term.resize(parseInt(matches[1]), parseInt(matches[2]));
          return term.write(message);
        }

        let matches = message.match && message.match(/^wtc:auth\((.*)\);$/);
        if (!matches || !this.auth(matches[1]))
          return socket.close();

        let shell = this.config.shell;
        let args = this.config.args || [];
        if (!shell) {
          if (os.platform() === "win32") {
            shell = 'powershell.exe';
            args = [];
          } else {
            shell = 'bash';
            args = ["--login"];
          }
        }

        let name = this.config.term || 'xterm-color';

        term = this.termMap[sequence] = pty.spawn(shell, args, {
          name: name,
          cols: 80,
          rows: 24,
          cwd: process.env.HOME,
          env: process.env,
        });

        console.log(new Date(), 'wTerm#' + sequence + ' shell spawned.');

        socket.send('wtc:init();');

        term.onData((data) => {
          socket.send(data);
        })

        term.onExit(() => {
          console.log(new Date(), 'wTerm#' + sequence + ' shell exited.');
          socket.close();
        })

      })

      socket.on("close", () => {
        console.log(new Date(), 'wTerm#' + sequence + ' connection closed.');
        if (!term)
          return;
        term.kill();
        delete this.termMap[sequence];
      });
    });

    app.ws('/tunnels/:port', (wsocket, request) => {
      let sequence = this.nextSequence++;
      let nsocket = undefined;
      let ip = request.ip;
      console.log(new Date(), 'wTerm#' + sequence + ' connection(' + ip + ') connected.');

      wsocket.on('message', (message) => {

        if (message instanceof Array)
          message = Buffer.concat(message);
        if (message instanceof ArrayBuffer)
          message = Buffer.from(message);

        if (nsocket) {
          return nsocket.write(message);
        }

        let matches = message.match && message.match(/^wtc:auth\((.*)\);$/);
        if (!matches || !this.auth(matches[1]))
          return wsocket.close();

        let port = parseInt(request.params.port);
        let ports = this.config.tunnels || [];
        if (!port || ports.indexOf(port) < 0) {
          return wsocket.close();
        }

        console.log(new Date(), 'wTerm#' + sequence + ' tunnel connecting localhost:' + port + ' ...');
        nsocket = net.connect(port);
        nsocket.on('connect', () => {
          console.log(new Date(), 'wTerm#' + sequence + ' tunnel established.');
          wsocket.send('wtc:init();');
        })
        nsocket.on('error', err => {
          console.log(new Date(), err)
        });
        nsocket.on('data', wsocket.send.bind(wsocket));
        nsocket.on('close', () => {
          console.log(new Date(), 'wTerm#' + sequence + ' tunnel closed.');
          wsocket.close();
        })
      });

      wsocket.on('error', (err) => {
        console.log(new Date(), err);
      })

      wsocket.on('close', () => {
        console.log(new Date(), 'wTerm#' + sequence + ' connection closed.');
        if (nsocket)
          nsocket.destroy();
      });

    });

  }

  async loadTOTPKey() {
    try {
      let svg = await fs.readFile('totp-key.svg', 'utf-8');
      let matches = svg.match(/<!-- wTerm TOTP Key: (.+) -->/);
      return matches && matches[1];
    } catch (e) {
      return undefined;
    }
  }

  async generateTOTPKey() {
    let key = twofactor.generate.key();
    let uri = 'otpauth://totp/' + encodeURIComponent(this.config.name || 'anonymous')
      + '?secret=' + encodeURIComponent(key)
      + '&issuer=' + encodeURIComponent('wTerm');
    let svg = '<!-- wTerm TOTP Key: ' + key + ' -->' + qrimage.imageSync(uri, { type: 'svg' });
    await fs.writeFile('totp-key.svg', svg);
    return key;
  }

  auth(secret) {
    if (this.config.secret == '@TOTP')
      return twofactor.verify(secret, this.totpKey);
    return secret == this.config.secret;
  }

  async listen() {
    try {
      console.log(new Date(), 'wTerm V0.3.0');
      console.log(new Date(), 'https://github.com/iwares/wterm');

      // Load/Generate TOTP key if secret is @TOTP.
      if (this.config.secret == '@TOTP') {
        let key = await this.loadTOTPKey();
        if (!key)
          key = await this.generateTOTPKey();
        this.totpKey = key;
      }

      // Listen
      let host = this.config.host;
      let port = this.config.port;
      await new Promise(resolve => {
        let server = this.app.listen(port, host, 511, resolve);
        this.server = server;
      });
      console.log(new Date(), 'Listening ' + host + ':' + port);

      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  shutdown() {
    return new Promise(async resolve => {
      for (let key in this.termMap)
        this.termMap[key].kill();
      this.server.close(() => resolve());
    });
  }

}
