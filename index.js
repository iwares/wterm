const Server = require('./server')
const path = require('path');
const fs = require('fs/promises');

async function loadConfiguration() {
  try {
    let json = await fs.readFile('config.json', 'utf-8');
    return JSON.parse(json);
  } catch (e) {
    console.log(e);
    return {};
  }
}

async function bootstrap() {

  process.chdir(__dirname);

  let config = await loadConfiguration();

  config.host = config.host || '0.0.0.0';
  config.port = config.port || 8080;
  config.secret = config.secret || '';

  let server = new Server(config);
  await server.listen();

  process.on('SIGINT', async () => {
    await server.shutdown();
    process.exit();
  });

}

bootstrap();
