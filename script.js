const dgram = require('dgram');
const fs = require('fs');
const readline = require('readline');

// --- CONSTANTES DE TEMPO E CONFIGURAÇÃO ---
const ROUTE_ADVERT_INTERVAL = 15000;
const PRINT_TABLE_INTERVAL = 20000;
const NEIGHBOR_CHECK_INTERVAL = 5000;
const NEIGHBOR_TIMEOUT = 35000;

// Validação dos argumentos iniciais
if (process.argv.length < 3) {
  console.error('Uso: node file.js <MEU_IP> [arquivo_config]');
  process.exit(1);
}

// --- VARIÁVEIS GLOBAIS ---
const MY_IP = process.argv[2];
const UDP_PORT = 9000;
const UDP_PORT_SEND = 9000;
const CONFIG_FILE = process.argv[3] || 'roteadores.txt';

let configuredNeighbors = [];
let neighborData = new Map();
let routingTable = new Map();

// NOVO: conjunto de vizinhos mortos
let deadNeighbors = new Set();

// --- LEITURA DA CONFIGURAÇÃO ---
try {
  const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  configuredNeighbors = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && l !== MY_IP);
} catch (err) {
  console.error(`Erro ao ler arquivo de configuração: ${err.message}`);
  process.exit(1);
}

for (const n of configuredNeighbors) {
  neighborData.set(n, {
    lastHeard: Date.now(),
    routes: {}
  });
}

// --- CONFIGURAÇÃO DO SOCKET UDP ---
const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error(`Erro no socket: ${err.message}`);
  socket.close();
});

socket.on('message', (msgBuf, rinfo) => {
  const msg = msgBuf.toString('utf-8').trim();
  const senderIP = rinfo.address.replace('::ffff:', '');

  if (msg.startsWith('!')) {
    handleTextMessage(msg, senderIP);
    console.log('[RECEBIDO]', msg);
  } else if (msg.startsWith('*')) {
    handleRouterAnnouncement(msg, senderIP);
    console.log('[RECEBIDO]', msg);
  } else if (msg.startsWith('#')) {
    handleRouteAnnouncement(msg, senderIP);
    console.log('[RECEBIDO]', msg);
  }
});

// Inicia o servidor
socket.bind(UDP_PORT, () => {
  console.log(`Roteador iniciado: IP ${MY_IP} na porta ${UDP_PORT}`);

  if (configuredNeighbors.length > 0) {
    sendRouterAnnouncement();
  }

  recomputeRoutingTable();
  setupCLI();

  setInterval(sendRoutingTable, ROUTE_ADVERT_INTERVAL);
  setInterval(printRoutingTable, PRINT_TABLE_INTERVAL);
  setInterval(checkTimeouts, NEIGHBOR_CHECK_INTERVAL);
});

// --- FUNÇÕES AUXILIARES ---

function now() {
  return Date.now();
}

function getNeighbor(ip) {
  if (!neighborData.has(ip)) {
    neighborData.set(ip, { lastHeard: now(), routes: {} });
    if (!configuredNeighbors.includes(ip)) {
      configuredNeighbors.push(ip);
    }
  }
  return neighborData.get(ip);
}

// --- LÓGICA DE ROTEAMENTO (DISTANCE VECTOR) ---

function recomputeRoutingTable() {
  const oldTableJson = JSON.stringify(Array.from(routingTable.entries()));
  const newTable = new Map();

  for (const [nIP, data] of neighborData.entries()) {
    
    // 🔥 IGNORA vizinhos mortos
    if (deadNeighbors.has(nIP)) continue;

    if (now() - data.lastHeard > NEIGHBOR_TIMEOUT) continue;

    if (!newTable.has(nIP) || newTable.get(nIP).metric > 1) {
      newTable.set(nIP, { metric: 1, nextHop: nIP });
    }

    for (const [destIP, cost] of Object.entries(data.routes)) {
      if (destIP === MY_IP) continue;

      const totalCost = cost + 1;

      if (!newTable.has(destIP)) {
        newTable.set(destIP, { metric: totalCost, nextHop: nIP });
      } else {
        const current = newTable.get(destIP);
        if (totalCost < current.metric) {
          newTable.set(destIP, { metric: totalCost, nextHop: nIP });
        }
      }
    }
  }

  routingTable = newTable;

  const newTableJson = JSON.stringify(Array.from(routingTable.entries()));
  if (oldTableJson !== newTableJson) {
    console.log('[ROTEAMENTO] Tabela atualizada. Enviando atualização...');
    printRoutingTable();
    sendRoutingTable();
  }
}

function sendRoutingTable() {
  let msg = '';
  for (const [dest, info] of routingTable.entries()) {
    if (dest === MY_IP) continue;
    msg += `#${dest}-${info.metric}`;
  }

  if (msg.length === 0) msg = '#';

  console.log('[ENVIO]', msg);

  const buf = Buffer.from(msg, 'utf-8');
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, () => {});
  }
}

function sendRouterAnnouncement() {
  const msg = `*${MY_IP}`;
  const buf = Buffer.from(msg, 'utf-8');
  console.log('[ENVIO]', msg);
  
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, () => {});
  }
}

// --- HANDLERS ---

function handleRouteAnnouncement(msg, senderIP) {
  const neighbor = getNeighbor(senderIP);

  // 🔥 REVIVE vizinho se estava morto
  if (deadNeighbors.has(senderIP)) {
    console.log(`[REVIVE] Vizinho ${senderIP} voltou a responder.#`);
    deadNeighbors.delete(senderIP);
  }

  neighbor.lastHeard = now();

  const parts = msg.split('#').filter(p => p.length > 0);
  const newRoutes = {};

  for (const p of parts) {
    const [dest, metricStr] = p.split('-');
    const metric = parseInt(metricStr, 10);
    if (dest && !isNaN(metric)) newRoutes[dest] = metric;
  }

  // 🔥 Remover rotas inconsistentes que dependiam dele
  const removed = [];
  for (const [dest, info] of routingTable.entries()) {
    if (info.nextHop === senderIP && !(dest in newRoutes)) {
      routingTable.delete(dest);
      removed.push(dest);
    }
  }
  if (removed.length)
    console.log(`[LIMPEZA] Rotas removidas pela falta no vizinho ${senderIP}: ${removed.join(', ')}`);

  neighbor.routes = newRoutes;

  recomputeRoutingTable();
}

function handleRouterAnnouncement(msg, senderIP) {
  const announcedIP = msg.substring(1).trim();

  if (deadNeighbors.has(senderIP)) {
    console.log(`[REVIVE] Vizinho ${senderIP} voltou a responder (*).`);
    deadNeighbors.delete(senderIP);
  }

  const neighbor = getNeighbor(senderIP);
  neighbor.lastHeard = now();

  console.log(`[EVENTO] Novo roteador detectado: ${announcedIP}`);

  neighbor.routes[announcedIP] = 0;

  sendRoutingTable();
  recomputeRoutingTable();
}

function handleTextMessage(msg, senderIP) {
  const payload = msg.substring(1);
  const parts = payload.split(';');

  if (parts.length < 3) return;

  const src = parts[0];
  const dest = parts[1];
  const text = parts.slice(2).join(';');

  if (dest === MY_IP) {
    console.log(`[MENSAGEM RECEBIDA] De: ${src} | Msg: ${text}`);
  } else {
    const route = routingTable.get(dest);
    if (route) {
      console.log(`[ENCAMINHANDO] Msg de ${src} para ${dest} via ${route.nextHop}`);
      const buf = Buffer.from(msg, 'utf-8');
      socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, () => {});
    } else {
      console.log(`[FALHA] Sem rota para ${dest}. Mensagem descartada.`);
    }
  }
}

// --- TIMEOUT DE VIZINHOS ---

function checkTimeouts() {
  let changed = false;

  for (const [ip, data] of neighborData.entries()) {
    if (now() - data.lastHeard > NEIGHBOR_TIMEOUT) {

      if (!deadNeighbors.has(ip)) {
        console.log(`[TIMEOUT] Vizinho ${ip} morreu. Marcando como DEAD.`);
        deadNeighbors.add(ip);
        changed = true;

        // Remove rotas via este vizinho
        for (const [dest, info] of routingTable.entries()) {
          if (info.nextHop === ip) {
            routingTable.delete(dest);
          }
        }
      }
    }
  }

  if (changed) {
    recomputeRoutingTable();
    sendRoutingTable();
  }
}

function printRoutingTable() {
  console.log('\n--- Tabela de Roteamento ---');
  console.log('IP Destino\tMétrica\tSaída (Next Hop)');
  for (const [dest, info] of routingTable.entries()) {
    console.log(`${dest}\t\t${info.metric}\t${info.nextHop}`);
  }
  console.log('----------------------------\n');
}

// --- CLI ---

function setupCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', line => {
    const parts = line.trim().split(' ');
    const cmd = parts[0];

    if (cmd === 'msg' && parts.length >= 3) {
      const dest = parts[1];
      const text = parts.slice(2).join(' ');
      const route = routingTable.get(dest);

      if (route) {
        const fullMsg = `!${MY_IP};${dest};${text}`;
        const buf = Buffer.from(fullMsg, 'utf-8');
        socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, (err) => {
          if (err) console.error(err.message);
          else console.log(`[CLI] Mensagem enviada para ${dest} via ${route.nextHop}: ${text}`);
        });
      } else {
        console.log(`[CLI] Erro: Destino inalcançável (Sem rota).`);
      }
    } else if (cmd === 'table') {
      printRoutingTable();
    } else if (cmd === 'on') {
      sendRouterAnnouncement();
    }
  });
}