// Imports e Constantes
const dgram = require('dgram');                   //Cria socket UDP
const fs = require('fs');
const readline = require('readline');

const ROUTE_ADVERT_INTERVAL = 15 * 1000;
const PRINT_TABLE_INTERVAL = 20 * 1000;
const NEIGHBOR_CHECK_INTERVAL = 5 * 1000;
const NEIGHBOR_TIMEOUT = 35 * 1000;

const STATE_INACTIVE = 0;
const STATE_HOLD = 2;
const STATE_ACTIVE = 1;

if (process.argv.length < 3) {
  console.error('Uso: node roteador.js <MEU_IP> [arquivo_roteadores]');
  process.exit(1);
}

const MY_IP = process.argv[2];
const UDP_PORT = process.argv[3];
const UDP_PORT_SEND = process.argv[4];
const CONFIG_FILE = process.argv[5] || 'roteadores.txt';

let neighbors = [];
let routingTable = new Map();
let neighborStates = new Map();

function loadNeighbors() {
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    neighbors = content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#') && l !== MY_IP);

    console.log('Vizinhos carregados a partir de', CONFIG_FILE, ':', neighbors);
  } catch (err) {
    console.error('Erro ao ler arquivo de configuração', CONFIG_FILE, err.message);
    process.exit(1);
  }
}

function nowMs() {
  return Date.now();
}

// Gera a nova tabela de vizinhos a cada iteração
function recomputeRoutingTable() {
  const oldTable = routingTable;
  const newTable = new Map();

  // Mantém todos os vizinhos do arquivo
  for (const n of neighbors) {
    const state = neighborStates.get(n);
    if (!state) continue;
    if (state.state === STATE_ACTIVE) {
      // Vizinho ativo, mantém na tabela
      newTable.set(n, { metric: 1, nextHop: n, state: STATE_ACTIVE });
    }
    // Vizinho em HOLD é ignorado na tabela, mas aparece nos prints
  }

  // Processa rotas anunciadas pelos vizinhos
  for (const [neighborIP, state] of neighborStates.entries()) {
    if (state.state !== STATE_ACTIVE) continue; // apenas vizinhos ativos
    const routes = state.routes || {};
    for (const [dest, metricFromNeighbor] of Object.entries(routes)) {
      if (dest === MY_IP) continue;
      const candidateMetric = metricFromNeighbor + 1;
      const existing = newTable.get(dest);
      if (!existing || candidateMetric < existing.metric) {
        newTable.set(dest, { metric: candidateMetric, nextHop: neighborIP, state: STATE_ACTIVE });
      }
    }
  }

  let changed = false;
  for (const [dest, newInfo] of newTable.entries()) {
    const oldInfo = oldTable.get(dest);
    if (!oldInfo) {
      console.log(`[ROTEAMENTO] Nova rota adicionada: ${dest} -> saída ${newInfo.nextHop}, métrica ${newInfo.metric}, estado ${newInfo.state}`);
      changed = true;
    } else if (oldInfo.metric !== newInfo.metric || oldInfo.nextHop !== newInfo.nextHop || oldInfo.state !== newInfo.state) {
      console.log(
        `[ROTEAMENTO] Rota atualizada: ${dest} (antes: saída ${oldInfo.nextHop}, métrica ${oldInfo.metric}, estado ${oldInfo.state}; agora: saída ${newInfo.nextHop}, métrica ${newInfo.metric}, estado ${newInfo.state})`
      );
      changed = true;
    }
  }

  for (const [dest, oldInfo] of oldTable.entries()) {
    if (!newTable.has(dest)) {
      console.log(`[ROTEAMENTO] Rota removida: ${dest} (era saída ${oldInfo.nextHop}, métrica ${oldInfo.metric})`);
      changed = true;
    }
  }

  routingTable = newTable;
  return changed;
}

// Gera mensagem #ip-métrica, que anuncia nova tabela
function buildRoutingAnnouncement() {
  let msg = '';
  for (const [dest, info] of routingTable.entries()) {
    if (dest === MY_IP) continue;
    msg += `#${dest}-${info.metric}`;
  }
  return msg.length === 0 ? '#' : msg;
}

// Envia tabela de roteamento
function sendRoutingTable() {
  const msg = buildRoutingAnnouncement();
  const buf = Buffer.from(msg, 'utf-8');
  if (routingTable.size === 0) return;
  for (const n of neighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, err => {
      if (err) {
        console.error(`[ERRO] Falha ao enviar tabela para ${n}:`, err.message);
      }
    });
  }
  console.log('[ENVIO] Tabela de roteamento enviada aos vizinhos.');
  console.log(msg);
}

// Envia mensagem de "boas-vindas" *IP
function sendRouterAnnouncement() {
  const msg = `*${MY_IP}`;
  const buf = Buffer.from(msg, 'utf-8');
  for (const n of neighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, err => {
      if (err) {
        console.error(`[ERRO] Falha ao enviar anúncio de roteador para ${n}:`, err.message);
      }
    });
  }
  console.log('[ENVIO]', msg);
}

// Imprime tabela de roteamento
function printRoutingTable() {
  console.log('==========================================');
  console.log(`Tabela de roteamento de ${MY_IP} (hora: ${new Date().toLocaleTimeString()})`);
  console.log('Destino\t\tMétrica\tSaída\tEstado');
  for (const [dest, info] of routingTable.entries()) {
    console.log(`${dest}\t${info.metric}\t${info.nextHop}\t${info.state}`);
  }
  if (routingTable.size === 0) {
    console.log('(vazia)');
  }
  console.log('==========================================\n');
}

// Métrica e estado dos vizinhos
function touchNeighbor(neighborIP, routesFromNeighbor, active = false) {
  let st = neighborStates.get(neighborIP);
  if (!st) {
    // Inicializa vizinho em HOLD
    st = { lastHeard: nowMs(), routes: {}, state: STATE_HOLD };
    neighborStates.set(neighborIP, st);
  }
  st.lastHeard = nowMs();
  if (routesFromNeighbor) {
    st.routes = routesFromNeighbor;
  }
  if (active && st.state !== STATE_ACTIVE) {
    // Recebeu * ou # → ativa e inicia contagem para INACTIVE
    st.state = STATE_ACTIVE;

    // Configura timeout para inativo após NEIGHBOR_TIMEOUT
    if (st.timeoutHandle) clearTimeout(st.timeoutHandle);
    st.timeoutHandle = setTimeout(() => {
      st.state = STATE_INACTIVE;

      // Remove vizinho de neighbors
      neighbors = neighbors.filter(n => n !== neighborIP);
      neighborStates.delete(neighborIP);

      const changed = recomputeRoutingTable();
      if (changed) sendRoutingTable();
    }, NEIGHBOR_TIMEOUT);
  }
}

// Função para detectar a comunicação com os vizinhos
function checkNeighborTimeouts() {
  // Agora não faz nada enquanto o vizinho estiver em HOLD
  let expired = false;
  for (const n of neighbors) {
    const st = neighborStates.get(n);
    if (!st) continue;
    const delta = nowMs() - st.lastHeard;
    if (st.state === STATE_ACTIVE && delta > NEIGHBOR_TIMEOUT) {
      // Timeout ativo tratado pelo setTimeout de touchNeighbor
      expired = true;
    }
  }
  if (expired) {
    const changed = recomputeRoutingTable();
    if (changed) {
      sendRoutingTable();
    }
  }
}

// Print vizinhos
function printNeighbors() {
  console.log('==========================================');
  console.log(`Vizinhos de ${MY_IP} (hora: ${new Date().toLocaleTimeString()})`);
  console.log('Vizinho\t\tStatus\t\tÚltimo Heard (s)');

  for (const n of neighbors) {
    const st = neighborStates.get(n);
    if (!st) {
      console.log(`${n}\tNUNCA VISTO\t-`);
      continue;
    }

    const delta = Math.floor((nowMs() - st.lastHeard) / 1000);

    let status;
    if (st.state === STATE_ACTIVE) status = 'ATIVO';
    else if (st.state === STATE_HOLD) status = 'HOLD';
    else status = 'INATIVO';

    console.log(`${n}\t${status}\t\t${delta}s`);
  }

  console.log('==========================================\n');
}

const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error('Erro no socket UDP:', err.message);
  socket.close();
});

socket.on('message', (msgBuf, rinfo) => {
  const msg = msgBuf.toString('utf-8').trim();
  const fromIP = rinfo.address;

  if (msg.startsWith('#')) {
    console.log('[RECEBIDO]', msg);
    touchNeighbor(fromIP, null, true);
    handleRouteAnnouncement(msg, fromIP);
  } else if (msg.startsWith('*')) {
    console.log('[RECEBIDO]', msg);
    touchNeighbor(fromIP, null, true);
    handleRouterAnnouncement(msg, fromIP);
  } else if (msg.startsWith('!')) {
    console.log('[RECEBIDO]', msg);
    handleTextMessage(msg, fromIP);
  } else {
    handleRouteAnnouncement(msg, fromIP);
  }
});

// Computa tabela dos vizinhos
function handleRouteAnnouncement(msg, fromIP) {
  const parts = msg.split('#').filter(p => p.length > 0);
  const routes = {};

  for (const part of parts) {
    const [dest, metricStr] = part.split('-');
    const metric = parseInt(metricStr, 10);
    if (!dest || isNaN(metric)) continue;
    routes[dest] = metric;
  }

  touchNeighbor(fromIP, routes, true);

  const changed = recomputeRoutingTable();
  if (changed) {
    printRoutingTable();
  }

  console.log(`[RECEBIDO] Anúncio de rotas de ${fromIP}:`, routes);
}

function handleRouterAnnouncement(msg, fromIP) {
  const ip = msg.substring(1).trim();
  console.log(`[RECEBIDO] Anúncio de roteador. IP informado: ${ip} (origem: ${fromIP})`);

  if (!ip && ip === MY_IP) return;

  let st = neighborStates.get(fromIP);
  if (!st) {
    st = { lastHeard: nowMs(), routes: {}, state: {} };
    neighborStates.set(fromIP, st);
    neighbors.push(fromIP);
    console.log(`[INFO] Novo vizinho adicionado: ${fromIP}`);
  }

  st.lastHeard = nowMs();
  st.routes[fromIP] = 1;
  touchNeighbor(fromIP, null, true); // ativa o vizinho
  const changed = recomputeRoutingTable();
  if (changed) {
    sendRoutingTable();
  }
}

// Cumputa mensagem recebida no formato !ip-origem;ip-destino;msg
function handleTextMessage(msg, fromIP) {
  const payload = msg.substring(1);
  const firstSep = payload.indexOf(';');
  const secondSep = payload.indexOf(';', firstSep + 1);

  if (firstSep === -1 || secondSep === -1) {
    console.log(`[RECEBIDO] Mensagem de texto mal formatada de ${fromIP}:`, msg);
    return;
  }

  const srcIP = payload.substring(0, firstSep);
  const destIP = payload.substring(firstSep + 1, secondSep);
  const text = payload.substring(secondSep + 1);

  if (!srcIP || !destIP) {
    console.log(`[RECEBIDO] Mensagem de texto mal formatada de ${fromIP}:`, msg);
    return;
  }

  if (destIP === MY_IP) {
    console.log(`[TEXTO - DESTINO] Mensagem chegou ao destino (${MY_IP}).`);
    console.log(`    Origem: ${srcIP}`);
    console.log(`    Destino: ${destIP}`);
    console.log(`    Texto: "${text}"\n`);
  } else {
    const route = routingTable.get(destIP);
    if (!route) {
      console.log(`[TEXTO - DESCARTE] Sem rota para ${destIP}. Mensagem descartada.`);
      console.log(`    Origem: ${srcIP}`);
      console.log(`    Destino: ${destIP}`);
      console.log(`    Texto: "${text}"\n`);
      return;
    }

    if (route.nextHop === fromIP) {
      console.log(`[TEXTO - LOOP] Próximo salto seria o mesmo roteador que enviou (${fromIP}). Não reenviando.`);
      return;
    }

    console.log(`[TEXTO - REPASSE] Repassando mensagem de ${srcIP} para ${destIP} via ${route.nextHop}.`);
    console.log(`    Texto: "${text}"\n`);

    const buf = Buffer.from(msg, 'utf-8');
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, err => {
      if (err) {
        console.error(`[ERRO] Falha ao encaminhar mensagem para ${route.nextHop}:`, err.message);
      }
    });
  }
}

// Função para envio de mensagens
function sendTextMessage(destIP, text) {
  const msg = `!${MY_IP};${destIP};${text}`;
  const route = routingTable.get(destIP);

  if (!route) {
    console.log(`[TEXTO - LOCAL] Sem rota para ${destIP}. Não foi possível enviar mensagem.`);
    return;
  }

  console.log(`[TEXTO - LOCAL] Enviando mensagem para ${destIP} via ${route.nextHop}.`);
  console.log(`    Texto: "${text}"\n`);

  const buf = Buffer.from(msg, 'utf-8');
  socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, err => {
    if (err) {
      console.error(`[ERRO] Falha ao enviar mensagem para ${route.nextHop}:`, err.message);
    }
  });
}

// Configura CLI
function setupCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `router(${MY_IP})> `
  });

  rl.prompt();

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const [cmd, ...rest] = trimmed.split(' ');

    switch (cmd.toLowerCase()) {
      case 'msg': {
        if (rest.length < 2) {
          console.log('Uso:msg <IP_DESTINO> <texto da mensagem>');
        } else {
          const destIP = rest[0];
          const text = rest.slice(1).join(' ');
          sendTextMessage(destIP, text);
        }
        break;
      }

      case 'table':
        printRoutingTable();
        break;
      
      case 'n':
        printNeighbors();
        break;

      case 'send':
        sendRoutingTable();
        break;

      case 'help':
        console.log('Comandos disponíveis:');
        console.log('  msg <IP_DESTINO> <texto>  -> envia mensagem de texto');
        console.log('  table                     -> mostra tabela de roteamento');
        console.log('  n                         -> mostra vizinhos');
        console.log('  send                      -> envia tabela de roteamento');
        console.log('  help                      -> mostra esta ajuda');
        console.log('  Ctrl+C                    -> sair');
        break;

      default:
        console.log('Comando não reconhecido. Use "help" para ajuda.');
    }

    rl.prompt();
  });
}

// Fluxo principal do programa
loadNeighbors();

for (const n of neighbors) {
  if (!neighborStates.has(n)) {
    neighborStates.set(n, { lastHeard: 0, routes: {}, state: STATE_HOLD });
  }
}

for (const n of neighbors) {
  routingTable.set(n, { metric: 1, nextHop: n, state: STATE_HOLD });
}

socket.bind(UDP_PORT, () => {
  console.log(`Roteador iniciado. IP: ${MY_IP}, porta UDP: ${UDP_PORT}`);
  console.log(`Arquivo de vizinhos: ${CONFIG_FILE}`);
  printRoutingTable();

  sendRouterAnnouncement();

  setInterval(sendRoutingTable, ROUTE_ADVERT_INTERVAL);
  setInterval(printRoutingTable, PRINT_TABLE_INTERVAL);
  setInterval(checkNeighborTimeouts, NEIGHBOR_CHECK_INTERVAL);

  setupCLI();
});
