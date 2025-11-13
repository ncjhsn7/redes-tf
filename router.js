const dgram = require("dgram");
const fs = require("fs");
const readline = require("readline");

const { parseRouteMessage, parseNewRouterMessage, parseTextMessage } = require("./messageHandler");
const { RoutingTable } = require("./routingTable");
const { loadConfig } = require("./config");

const PORT = 9000;

// ======================
//  CONFIGURAÇÃO INICIAL
// ======================
const myIP = process.argv[2];
if (!myIP) {
    console.log("Use: node router.js <MEU_IP>");
    process.exit(1);
}

console.log("Iniciando roteador", myIP);

const neighbors = loadConfig("roteadores.txt");
const routingTable = new RoutingTable(myIP, neighbors);

const socket = dgram.createSocket("udp4");

// Timestamp do último anúncio de cada vizinho
const lastHeard = {};
neighbors.forEach(n => lastHeard[n] = Date.now());

// ==========================
//   ENVIO DE TABELA DE ROTAS
// ==========================
function sendRoutingTable(force = false) {
    const msg = routingTable.serializeForSend();
    neighbors.forEach(ip => {
        socket.send(msg, PORT, ip);
    });

    if (force)
        console.log("[Envio imediato] Tabela enviada.");
    else
        console.log("[Rotina] Tabela enviada.");
}

// ==========================
// ANÚNCIO INICIAL DO ROTEADOR
// ==========================
function sendInitialAnnounce() {
    const msg = "*" + myIP;
    neighbors.forEach(ip => {
        socket.send(msg, PORT, ip);
    });
    console.log("[ANÚNCIO] Novo roteador informado aos vizinhos.");
}

// ==========================
//    RECEBIMENTO DE MENSAGENS
// ==========================
socket.on("message", (msgBuffer, rinfo) => {
    const msg = msgBuffer.toString();
    const fromIP = rinfo.address;

    // Atualiza timestamp
    lastHeard[fromIP] = Date.now();

    // Mensagem de tabela de rotas
    if (msg.startsWith("#")) {
        const routes = parseRouteMessage(msg);
        const changed = routingTable.updateFromNeighbor(fromIP, routes);

        if (changed) {
            console.log("Tabela foi atualizada!");
            routingTable.print();
            sendRoutingTable(true); // envio imediato
        }
        return;
    }

    // Mensagem de anúncio de roteador novo
    if (msg.startsWith("*")) {
        const newRouterIP = parseNewRouterMessage(msg);
        routingTable.addDirectNeighbor(newRouterIP);
        routingTable.print();
        return;
    }

    // Mensagem de texto
    if (msg.startsWith("!")) {
        const data = parseTextMessage(msg);

        console.log("\n📩 Mensagem recebida:");
        console.log("  Origem: ", data.src);
        console.log("  Destino:", data.dst);
        console.log("  Texto:  ", data.text);

        if (data.dst === myIP) {
            console.log("  ✔ Mensagem chegou ao destino!");
        } else {
            const nextHop = routingTable.getNextHop(data.dst);
            if (!nextHop) {
                console.log("  ❌ Sem rota para o destino. Mensagem descartada.");
                return;
            }
            console.log("  ➡ Encaminhando para", nextHop);
            socket.send(msg, PORT, nextHop);
        }
    }
});

// ==========================
//     TIMEOUT DE VIZINHOS
// ==========================
setInterval(() => {
    const now = Date.now();

    for (const ip in lastHeard) {
        if (now - lastHeard[ip] > 35000) {
            console.log(`⚠ Vizinho ${ip} está inacessível. Removendo rotas...`);
            routingTable.removeRoutesVia(ip);
            routingTable.print();
        }
    }
}, 5000);

// ==========================
//     ENVIO PERIÓDICO 15s
// ==========================
setInterval(sendRoutingTable, 15000);

// ==========================
//   INPUT DO USUÁRIO (texto)
// ==========================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askMessage() {
    rl.question("Enviar mensagem (destino texto): ", (line) => {
        const parts = line.split(" ");
        if (parts.length < 2) return askMessage();

        const dst = parts[0];
        const text = parts.slice(1).join(" ");

        const nextHop = routingTable.getNextHop(dst);
        if (!nextHop) {
            console.log("❌ Não há rota para o destino.");
            return askMessage();
        }

        const msg = `!${myIP};${dst};${text}`;
        socket.send(msg, PORT, nextHop);

        console.log("Mensagem enviada.");
        askMessage();
    });
}

askMessage();

// =====================
sendInitialAnnounce();
routingTable.print();
socket.bind(PORT);
