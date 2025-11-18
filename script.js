const dgram = require('dgram');
const fs = require('fs');
const readline = require('readline');

// --- CONSTANTES DE TEMPO E CONFIGURAÇÃO ---
// Intervalo de envio da tabela para vizinhos (15 segundos)
const ROUTE_ADVERT_INTERVAL = 15000;
// Intervalo de impressão da tabela na tela (20 segundos)
const PRINT_TABLE_INTERVAL = 20000;
// Intervalo para checar se vizinhos estão mudos (5 segundos)
const NEIGHBOR_CHECK_INTERVAL = 5000;
// Tempo limite para considerar um vizinho morto (35 segundos sem resposta)
const NEIGHBOR_TIMEOUT = 35000;

// Validação dos argumentos iniciais
if (process.argv.length < 3) {
  console.error('Uso: node file.js <MEU_IP> [arquivo_config]');
  process.exit(1);
}

// --- VARIÁVEIS GLOBAIS ---
const MY_IP = process.argv[2];
const UDP_PORT = 9000; //parseInt(process.argv[3]);
const UDP_PORT_SEND = 9000; //parseInt(process.argv[4]);
const CONFIG_FILE = process.argv[3] || 'roteadores.txt';

let configuredNeighbors = []; // Lista de vizinhos lida do arquivo
let neighborData = new Map(); // Guarda o estado (última vez visto e rotas) de cada vizinho
let routingTable = new Map(); // A tabela de roteamento final

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

// Inicializa a memória para os vizinhos conhecidos no arquivo
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
  // Remove prefixo IPv6 se o Node adicionar, para garantir comparação de string correta
  const senderIP = rinfo.address.replace('::ffff:', '');

  // Roteamento de mensagens baseado no primeiro caractere (Protocolo)
  if (msg.startsWith('!')) {
    handleTextMessage(msg, senderIP);        // Mensagem de Conversa
    console.log('[RECEBIDO]', msg);
  } else if (msg.startsWith('*')) {
    handleRouterAnnouncement(msg, senderIP); // Novo roteador na rede
    console.log('[RECEBIDO]', msg);
  } else if (msg.startsWith('#')) {
    handleRouteAnnouncement(msg, senderIP);  // Atualização de Rotas (Distance Vector)
    console.log('[RECEBIDO]', msg);
  }
});

// Inicia o servidor
socket.bind(UDP_PORT, () => {
  console.log(`Roteador iniciado: IP ${MY_IP} na porta ${UDP_PORT}`);
  
  // Se houver vizinhos configurados, anuncia presença imediatamente ao ligar
  if (configuredNeighbors.length > 0) {
    sendRouterAnnouncement();
  }

  // Estado inicial
  recomputeRoutingTable();
  setupCLI();

  // Configura os temporizadores cíclicos
  setInterval(sendRoutingTable, ROUTE_ADVERT_INTERVAL);
  setInterval(printRoutingTable, PRINT_TABLE_INTERVAL);
  setInterval(checkTimeouts, NEIGHBOR_CHECK_INTERVAL);
});

// --- FUNÇÕES AUXILIARES ---

function now() {
  return Date.now();
}

// Obtém ou cria a entrada de um vizinho na memória
function getNeighbor(ip) {
  if (!neighborData.has(ip)) {
    neighborData.set(ip, { lastHeard: now(), routes: {} });
    // Adiciona à lista de vizinhos se for um novo descoberto dinamicamente
    if (!configuredNeighbors.includes(ip)) {
      configuredNeighbors.push(ip);
    }
  }
  return neighborData.get(ip);
}

// --- LÓGICA DE ROTEAMENTO (DISTANCE VECTOR) ---

function recomputeRoutingTable() {
  // Guarda versão anterior para detectar mudanças
  const oldTableJson = JSON.stringify(Array.from(routingTable.entries()));
  const newTable = new Map();

  for (const [nIP, data] of neighborData.entries()) {
    // Se o vizinho expirou (timeout), ignoramos as rotas dele
    if (now() - data.lastHeard > NEIGHBOR_TIMEOUT) continue;

    // Adiciona rota direta para o vizinho (Custo 1)
    if (!newTable.has(nIP) || newTable.get(nIP).metric > 1) {
      newTable.set(nIP, { metric: 1, nextHop: nIP });
    }

    // Processa as rotas que este vizinho nos oferece
    for (const [destIP, cost] of Object.entries(data.routes)) {
      if (destIP === MY_IP) continue; // Evita loop para nós mesmos
      
      const totalCost = cost + 1; // Custo total = custo do vizinho + 1
      
      // Se é uma rota nova ou uma rota melhor (menor métrica), atualizamos
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

  // Se houve mudança, avisa e dispara envio imediato (Triggered Update)
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
    // Split Horizon simples: não enviamos a rota de volta para quem a originou (opcional, mas aqui enviamos para todos)
    if (dest === MY_IP) continue;
    msg += `#${dest}-${info.metric}`;
  }
  
  // FIX CRÍTICO: Se a mensagem estiver vazia (sem rotas), enviamos apenas '#'
  // Isso serve como "Heartbeat" para o vizinho saber que ainda estamos vivos.
  if (msg.length === 0) msg = '#';
  console.log('[ENVIO]', msg);

  const buf = Buffer.from(msg, 'utf-8');
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, (err) => {
      // Erros de envio são ignorados para não travar o fluxo
    });
  }
}

function sendRouterAnnouncement() {
  // Anuncia presença para vizinhos: *MEU_IP
  const msg = `*${MY_IP}`;
  const buf = Buffer.from(msg, 'utf-8');
  console.log('[ENVIO]', msg);
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, (err) => {});
  }
}

// --- HANDLERS DE MENSAGENS ---

function handleRouteAnnouncement(msg, senderIP) {
  const neighbor = getNeighbor(senderIP);
  neighbor.lastHeard = now(); // Reseta o timer de timeout do vizinho
  
  // Formato da msg: #IP-Metrica#IP-Metrica
  const parts = msg.split('#').filter(p => p.length > 0);
  neighbor.routes = {}; // Limpa rotas antigas para substituir pelas novas

  for (const p of parts) {
    const [dest, metricStr] = p.split('-');
    const metric = parseInt(metricStr, 10);
    if (dest && !isNaN(metric)) {
      neighbor.routes[dest] = metric;
    }
  }
  recomputeRoutingTable();
}

function handleRouterAnnouncement(msg, senderIP) {
  const announcedIP = msg.substring(1).trim();
  if (announcedIP === MY_IP) return;
  
  console.log(`[EVENTO] Novo roteador detectado: ${announcedIP}`);
  const neighbor = getNeighbor(senderIP);
  neighbor.lastHeard = now();
  // Adiciona temporariamente rota zero para o vizinho novo para acelerar convergência
  neighbor.routes[announcedIP] = 0; 
  
  sendRoutingTable(); // Responde imediatamente
  recomputeRoutingTable();
}

function handleTextMessage(msg, senderIP) {
  // Formato: !Origem;Destino;Mensagem
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
      socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, (err) => {});
    } else {
      console.log(`[FALHA] Sem rota para ${dest}. Mensagem descartada.`);
    }
  }
}

// --- VERIFICAÇÃO DE VIZINHOS INATIVOS ---

function checkTimeouts() {
  let changed = false;
  for (const [ip, data] of neighborData.entries()) {
    // Verifica se o tempo desde a última mensagem excede 35s
    if (now() - data.lastHeard > NEIGHBOR_TIMEOUT) {
      if (routingTable.has(ip)) { 
        changed = true; 
        console.log(`[TIMEOUT] Vizinho ${ip} parou de responder.`);
      }
    }
  }
  if (changed) recomputeRoutingTable();
}

function printRoutingTable() {
  console.log('\n--- Tabela de Roteamento ---');
  console.log('IP Destino\tMétrica\tSaída (Next Hop)');
  for (const [dest, info] of routingTable.entries()) {
    console.log(`${dest}\t\t${info.metric}\t${info.nextHop}`);
  }
  console.log('----------------------------\n');
}

// --- INTERFACE DE LINHA DE COMANDO (CLI) ---

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

