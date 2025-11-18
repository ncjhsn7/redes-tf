const dgram = require('dgram');
const fs = require('fs');
const readline = require('readline');

const ROUTE_ADVERT_INTERVAL = 15000;
const PRINT_TABLE_INTERVAL = 20000;
const NEIGHBOR_CHECK_INTERVAL = 5000;
const NEIGHBOR_TIMEOUT = 35000;

if (process.argv.length < 5) {
  console.error('Usage: node roteador.js <MY_IP> <PORT> <SEND_PORT> [config_file]');
  process.exit(1);
}

const MY_IP = process.argv[2];
const UDP_PORT = parseInt(process.argv[3]);
const UDP_PORT_SEND = parseInt(process.argv[4]);
const CONFIG_FILE = process.argv[5] || 'roteadores.txt';

let configuredNeighbors = [];
let neighborData = new Map();
let routingTable = new Map();

try {
  const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  configuredNeighbors = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && l !== MY_IP);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

for (const n of configuredNeighbors) {
  neighborData.set(n, {
    lastHeard: Date.now(),
    routes: {}
  });
}

const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error(err.message);
  socket.close();
});

socket.on('message', (msgBuf, rinfo) => {
  const msg = msgBuf.toString('utf-8').trim();
  const senderIP = rinfo.address.replace('::ffff:', '');

  if (msg.startsWith('!')) {
    handleTextMessage(msg, senderIP);
  } else if (msg.startsWith('*')) {
    handleRouterAnnouncement(msg, senderIP);
  } else if (msg.startsWith('#')) {
    handleRouteAnnouncement(msg, senderIP);
  }
});

socket.bind(UDP_PORT, () => {
  console.log(`Router ${MY_IP} running on port ${UDP_PORT}`);
  recomputeRoutingTable();
  setupCLI();

  setInterval(sendRoutingTable, ROUTE_ADVERT_INTERVAL);
  setInterval(printRoutingTable, PRINT_TABLE_INTERVAL);
  setInterval(checkTimeouts, NEIGHBOR_CHECK_INTERVAL);
});

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

function recomputeRoutingTable() {
  const oldTableJson = JSON.stringify(Array.from(routingTable.entries()));
  const newTable = new Map();

  for (const [nIP, data] of neighborData.entries()) {
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
    console.log('[ROUTING] Table Updated.');
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

  const buf = Buffer.from(msg, 'utf-8');
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, (err) => {
      if (err) {/* ignore */}
    });
  }
}

function sendRouterAnnouncement() {
  const msg = `*${MY_IP}`;
  const buf = Buffer.from(msg, 'utf-8');
  for (const n of configuredNeighbors) {
    socket.send(buf, 0, buf.length, UDP_PORT_SEND, n, (err) => {});
  }
}

function handleRouteAnnouncement(msg, senderIP) {
  const neighbor = getNeighbor(senderIP);
  neighbor.lastHeard = now();
  
  const parts = msg.split('#').filter(p => p.length > 0);
  neighbor.routes = {}; 

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
  
  console.log(`[EVENT] New router detected: ${announcedIP}`);
  const neighbor = getNeighbor(senderIP);
  neighbor.lastHeard = now();
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
    console.log(`[TEXT RECEIVED] From: ${src} | To: ${dest} | Msg: ${text}`);
  } else {
    const route = routingTable.get(dest);
    if (route) {
      console.log(`[TEXT FORWARD] Forwarding msg from ${src} to ${dest} via ${route.nextHop}`);
      const buf = Buffer.from(msg, 'utf-8');
      socket.send(buf, 0, buf.length, UDP_PORT_SEND, route.nextHop, (err) => {});
    } else {
      console.log(`[TEXT DROP] No route for ${dest}. Msg from ${src} discarded.`);
    }
  }
}

function checkTimeouts() {
  let changed = false;
  for (const [ip, data] of neighborData.entries()) {
    if (now() - data.lastHeard > NEIGHBOR_TIMEOUT) {
      if (routingTable.has(ip)) { 
        changed = true; 
        console.log(`[TIMEOUT] Neighbor ${ip} expired.`);
      }
    }
  }
  if (changed) recomputeRoutingTable();
}

function printRoutingTable() {
  console.log('\n--- Routing Table ---');
  console.log('Dest IP\t\tMetric\tNext Hop');
  for (const [dest, info] of routingTable.entries()) {
    console.log(`${dest}\t${info.metric}\t${info.nextHop}`);
  }
  console.log('---------------------\n');
}

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
          else console.log(`[CLI] Message sent to ${dest} via ${route.nextHop}`);
        });
      } else {
        console.log(`[CLI] No route to ${dest}`);
      }
    } else if (cmd === 'table') {
      printRoutingTable();
    } else if (cmd === 'announce') {
      sendRouterAnnouncement();
    }
  });
}

if (configuredNeighbors.length > 0) {
  sendRouterAnnouncement();
}