const express = require('express');
const expressws = require('express-ws');
const path = require('path');
const pty = require('node-pty');
const os = require("os");

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
          var matches = message.match(/^wtc:resize\((\d+),(\d+)\);$/);
          if (matches)
            return term.resize(parseInt(matches[1]), parseInt(matches[2]));
          return term.write(message);
        }

        var matches = message.match(/^wtc:auth\((.*)\);$/);
        if (!matches || matches[1] != this.config.secret)
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

  }

  async listen() {
    try {
      console.log(new Date(), 'wTerm V0.1.1');
      console.log(new Date(), 'https://github.com/iwares/wterm');
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
