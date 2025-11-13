
const dgram = require('dgram');
const fs = require('fs');
const readline = require('readline');

const UDP_PORT = 9000;
const ROUTE_ADVERT_INTERVAL = 15 * 1000;
const PRINT_TABLE_INTERVAL = 20 * 1000;
const NEIGHBOR_CHECK_INTERVAL = 5 * 1000;
const NEIGHBOR_TIMEOUT = 35 * 1000;

if (process.argv.length < 3) {
  console.error('Uso: node roteador.js <MEU_IP> [arquivo_roteadores]');
  process.exit(1);
}

const MY_IP = process.argv[2];
const CONFIG_FILE = process.argv[3] || 'roteadores.txt';


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




function recomputeRoutingTable() {
  const oldTable = routingTable;
  const newTable = new Map();

  
  for (const n of neighbors) {
    const state = neighborStates.get(n);
    const alive = state && (nowMs() - state.lastHeard <= NEIGHBOR_TIMEOUT);
    
    if (!state) {
      newTable.set(n, { metric: 1, nextHop: n });
    } else if (alive) {
      newTable.set(n, { metric: 1, nextHop: n });
    }
  }

  
  for (const [neighborIP, state] of neighborStates.entries()) {
    if (nowMs() - state.lastHeard > NEIGHBOR_TIMEOUT) continue; 
    const routes = state.routes || {};
    for (const [dest, metricFromNeighbor] of Object.entries(routes)) {
      if (dest === MY_IP) continue; 
      const candidateMetric = metricFromNeighbor + 1;
      const existing = newTable.get(dest);
      if (!existing || candidateMetric < existing.metric) {
        newTable.set(dest, { metric: candidateMetric, nextHop: neighborIP });
      }
    }
  }

  let changed = false;
  for (const [dest, newInfo] of newTable.entries()) {
    const oldInfo = oldTable.get(dest);
    if (!oldInfo) {
      console.log(`[ROTEAMENTO] Nova rota adicionada: ${dest} -> saida ${newInfo.nextHop}, métrica ${newInfo.metric}`);
      changed = true;
    } else if (oldInfo.metric !== newInfo.metric || oldInfo.nextHop !== newInfo.nextHop) {
      console.log(
        `[ROTEAMENTO] Rota atualizada: ${dest} (antes: saída ${oldInfo.nextHop}, métrica ${oldInfo.metric}; agora: saída ${newInfo.nextHop}, métrica ${newInfo.metric})`
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

function buildRoutingAnnouncement() {
  let msg = '';
  for (const [dest, info] of routingTable.entries()) {
    if (dest === MY_IP) continue; 
    msg += `#${dest}-${info.metric}`;
  }
  return msg.length === 0 ? '#': msg;
}

function sendRoutingTable() {
  const msg = buildRoutingAnnouncement();
  const buf = Buffer.from(msg, 'utf-8');
  for (const n of neighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT, n, err => {
      if (err) {
        console.error(`[ERRO] Falha ao enviar tabela para ${n}:`, err.message);
      }
    });
  }
  console.log('[ENVIO] Tabela de roteamento enviada aos vizinhos.');
}


function sendRouterAnnouncement() {
  const msg = `*${MY_IP}`;
  const buf = Buffer.from(msg, 'utf-8');
  for (const n of neighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT, n, err => {
      if (err) {
        console.error(`[ERRO] Falha ao enviar anúncio de roteador para ${n}:`, err.message);
      }
    });
  }
  console.log('[ENVIO] Anúncio de roteador enviado aos vizinhos.');
}


function printRoutingTable() {
  console.log('==========================================');
  console.log(`Tabela de roteamento de ${MY_IP} (hora: ${new Date().toLocaleTimeString()})`);
  console.log('Destino\t\tMétrica\tSaída');
  for (const [dest, info] of routingTable.entries()) {
    console.log(`${dest}\t${info.metric}\t${info.nextHop}`);
  }
  if (routingTable.size === 0) {
    console.log('(vazia)');
  }
  console.log('==========================================\n');
}


function touchNeighbor(neighborIP, routesFromNeighbor) {
  let st = neighborStates.get(neighborIP);
  if (!st) {
    st = { lastHeard: nowMs(), routes: {} };
    neighborStates.set(neighborIP, st);
  }
  st.lastHeard = nowMs();
  if (routesFromNeighbor) {
    st.routes = routesFromNeighbor;
  }
}


function checkNeighborTimeouts() {
  let expired = false;
  for (const n of neighbors) {
    const st = neighborStates.get(n);
    if (!st) continue;
    const delta = nowMs() - st.lastHeard;
    if (delta > NEIGHBOR_TIMEOUT) {
      console.log(`[TIMEOUT] Vizinho ${n} não envia mensagens há ${Math.floor(delta / 1000)}s. Removendo rotas associadas.`);
      neighborStates.delete(n);
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



const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error('Erro no socket UDP:', err.message);
  socket.close();
});

socket.on('message', (msgBuf, rinfo) => {
  const msg = msgBuf.toString('utf-8').trim();
  const fromIP = rinfo.address;

  
  touchNeighbor(fromIP);

  if (msg.startsWith('#')) {
    handleRouteAnnouncement(msg, fromIP);
  } else if (msg.startsWith('*')) {
    handleRouterAnnouncement(msg, fromIP);
  } else if (msg.startsWith('!')) {
    handleTextMessage(msg, fromIP);
  } else {
    console.log(`[RECEBIDO] Mensagem desconhecida de ${fromIP}:`, msg);
  }
});


function handleRouteAnnouncement(msg, fromIP) {
  
  const parts = msg.split('#').filter(p => p.length > 0);
  const routes = {};

  for (const part of parts) {
    const [dest, metricStr] = part.split('-');
    const metric = parseInt(metricStr, 10);
    if (!dest || isNaN(metric)) continue;
    routes[dest] = metric;
  }

  
  touchNeighbor(fromIP, routes);

  
  const changed = recomputeRoutingTable();
  if (changed) {
    
    sendRoutingTable();
  }

  console.log(`[RECEBIDO] Anúncio de rotas de ${fromIP}:`, routes);
}


function handleRouterAnnouncement(msg, fromIP) {
  
  const ip = msg.substring(1).trim();
  console.log(`[RECEBIDO] Anúncio de roteador. IP informado: ${ip} (origem: ${fromIP})`);

  if (ip && ip !== MY_IP) {
    
    let st = neighborStates.get(fromIP);
    if (!st) {
      st = { lastHeard: nowMs(), routes: {} };
      neighborStates.set(fromIP, st);
    }
    st.routes[ip] = 0; 
    const changed = recomputeRoutingTable();
    if (changed) {
      sendRoutingTable();
    }
  }
}


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
    socket.send(buf, 0, buf.length, UDP_PORT, route.nextHop, err => {
      if (err) {
        console.error(`[ERRO] Falha ao encaminhar mensagem para ${route.nextHop}:`, err.message);
      }
    });
  }
}


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
  socket.send(buf, 0, buf.length, UDP_PORT, route.nextHop, err => {
    if (err) {
      console.error(`[ERRO] Falha ao enviar mensagem para ${route.nextHop}:`, err.message);
    }
  });
}









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

    // --- MUDANÇA PRINCIPAL ---
    // 1. Verifica se a linha começa com '!'
    if (trimmed.startsWith('!')) {
      const payload = trimmed.slice(1); // Remove o '!'
      const parts = payload.split(';');   // Divide a string por ';'

      if (parts.length === 3) {
        const sourceIP = parts[0];
        const destIP = parts[1];
        const text = parts[2];

        // Opcional: Você pode validar se o sourceIP é o mesmo do roteador
        if (sourceIP !== MY_IP) {
          console.log(`Aviso: O IP de origem (${sourceIP}) não corresponde ao IP deste roteador (${MY_IP}).`);
        }

        // Chama a função de envio
        // A sua função original `sendTextMessage` só pedia (destIP, text)
        sendTextMessage(destIP, text);

      } else {
        console.log('Formato inválido. Uso correto: !SEU_IP;IP_DESTINO;mensagem');
      }

      rl.prompt();
      return; // Importante: para a execução para não cair no 'switch'
    }
    // --- FIM DA MUDANÇA ---


    // Lógica antiga para os outros comandos
    const [cmd, ...rest] = trimmed.split(' ');

    switch (cmd.toLowerCase()) {
      
      // O 'case "msg":' foi removido, pois agora é tratado pelo '!'

      case 'table':
        printRoutingTable();
        break;

      case 'help':
        console.log('Comandos disponíveis:');
        // 2. Atualiza o texto de ajuda
        console.log('  !SEU_IP;IP_DESTINO;mensagem -> envia mensagem de texto');
        console.log('  table                       -> mostra tabela de roteamento');
        console.log('  help                        -> mostra esta ajuda');
        console.log('  Ctrl+C                      -> sair');
        break;

      default:
        console.log('Comando não reconhecido. Use "help" para ajuda.');
    }

    rl.prompt();
  });
}



loadNeighbors();


for (const n of neighbors) {
  if (!neighborStates.has(n)) {
    neighborStates.set(n, { lastHeard: 0, routes: {} });
  }
}


for (const n of neighbors) {
  routingTable.set(n, { metric: 1, nextHop: n });
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