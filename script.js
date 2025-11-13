// roteador.js
// -----------------------------------------------------------
// Trabalho de Redes - Roteador com troca de tabelas (UDP)
// Uso:
//   node roteador.js <MEU_IP> [arquivo_roteadores]
// Exemplo:
//   node roteador.js 10.1.1.134 roteadores.txt
// -----------------------------------------------------------

const dgram = require('dgram');
const fs = require('fs');
const readline = require('readline');

// ---------------------- CONFIGURAÇÕES ----------------------

// Porta fixa (especificada no enunciado)
const UDP_PORT = 9000;

// Intervalo para enviar tabela de rotas (ms)
const ROUTE_ADVERT_INTERVAL = 15 * 1000;

// Intervalo para imprimir tabela de roteamento (ms)
const PRINT_TABLE_INTERVAL = 20 * 1000;

// Intervalo para verificar timeouts de vizinhos (ms)
const NEIGHBOR_CHECK_INTERVAL = 5 * 1000;

// Tempo limite sem ouvir um vizinho antes de esquecê-lo (ms)
const NEIGHBOR_TIMEOUT = 35 * 1000;

// ---------------------- PARÂMETROS CLI ----------------------

if (process.argv.length < 3) {
    console.error('Uso: node roteador.js <MEU_IP> [arquivo_roteadores]');
    process.exit(1);
}

const MY_IP = process.argv[2];
const CONFIG_FILE = process.argv[3] || 'roteadores.txt';

// ---------------------- ESTRUTURAS DE DADOS ----------------------

// Vizinhos configurados (do arquivo roteadores.txt)
let neighbors = [];

// Tabela de roteamento: Map<destIP, { metric, nextHop }>
let routingTable = new Map();

// Estado por vizinho: Map<neighborIP, { lastHeard, routes: { [dest]: metric } }>
let neighborStates = new Map();

// ---------------------- FUNÇÕES AUXILIARES ----------------------

function nowMs() {
    return Date.now();
}

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

// Recalcula a tabela de roteamento com base em:
// - vizinhos diretos vivos (métrica 1)
// - últimas tabelas recebidas de cada vizinho
function recomputeRoutingTable() {
    const oldTable = routingTable;
    const newTable = new Map();
    const now = nowMs();

    // 1) Rotas diretas para vizinhos vivos: métrica 1
    for (const n of neighbors) {
        const state = neighborStates.get(n);
        if (!state) continue; // se não temos estado, não cria rota

        const alive = (now - state.lastHeard <= NEIGHBOR_TIMEOUT);
        if (alive) {
            newTable.set(n, {
                metric: 1,
                nextHop: n
            });
        }
    }

    // 2) Rotas aprendidas dos vizinhos (distance vector)
    for (const [neighborIP, state] of neighborStates.entries()) {
        if (!state) continue;
        const alive = (now - state.lastHeard <= NEIGHBOR_TIMEOUT);
        if (!alive) continue;

        const routes = state.routes || {};
        for (const [dest, metricFromNeighbor] of Object.entries(routes)) {
            if (dest === MY_IP) continue; // não cria rota para si mesmo
            const candidateMetric = metricFromNeighbor + 1;
            const existing = newTable.get(dest);
            if (!existing || candidateMetric < existing.metric) {
                newTable.set(dest, {
                    metric: candidateMetric,
                    nextHop: neighborIP
                });
            }
        }
    }

    // 3) Comparar com tabela anterior para detectar mudanças
    let changed = false;

    // Adições / atualizações
    for (const [dest, newInfo] of newTable.entries()) {
        const oldInfo = oldTable.get(dest);
        if (!oldInfo) {
            console.log(
                `[ROTEAMENTO] Nova rota adicionada: ${dest} -> saida ${newInfo.nextHop}, métrica ${newInfo.metric}`
            );
            changed = true;
        } else if (oldInfo.metric !== newInfo.metric || oldInfo.nextHop !== newInfo.nextHop) {
            console.log(
                `[ROTEAMENTO] Rota atualizada: ${dest} (antes: saída ${oldInfo.nextHop}, métrica ${oldInfo.metric}; ` +
                `agora: saída ${newInfo.nextHop}, métrica ${newInfo.metric})`
            );
            changed = true;
        }
    }

    // Remoções
    for (const [dest, oldInfo] of oldTable.entries()) {
        if (!newTable.has(dest)) {
            console.log(
                `[ROTEAMENTO] Rota removida: ${dest} (era saída ${oldInfo.nextHop}, métrica ${oldInfo.metric})`
            );
            changed = true;
        }
    }

    routingTable = newTable;
    return changed;
}

// Serializa a tabela de roteamento local para o formato de anúncio de rotas:
// #IP-METRICA#IP-METRICA...
function buildRoutingAnnouncement() {
    let msg = '';
    for (const [dest, info] of routingTable.entries()) {
        if (dest === MY_IP) continue; // não incluir rota para si mesmo
        msg += `#${dest}-${info.metric}`;
    }
    return msg; // pode ser string vazia
}

// Envia a tabela de rotas para todos os vizinhos configurados
function sendRoutingTable() {
    const msg = buildRoutingAnnouncement();
    if (!msg) return; // nada para enviar

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

// Envia anúncio de roteador: *MEU_IP
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

// Imprime a tabela de roteamento em formato amigável
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

// Atualiza estado do vizinho (timestamp + rotas, se houver)
function touchNeighbor(neighborIP, routesFromNeighbor) {
    let st = neighborStates.get(neighborIP);
    if (!st) {
        st = {
            lastHeard: nowMs(),
            routes: {}
        };
        neighborStates.set(neighborIP, st);
    }
    st.lastHeard = nowMs();
    if (routesFromNeighbor) {
        st.routes = routesFromNeighbor;
    }
}

// Verifica timeouts de vizinhos
function checkNeighborTimeouts() {
    const now = nowMs();
    let expired = false;

    for (const n of neighbors) {
        const st = neighborStates.get(n);
        if (!st) continue;

        const delta = now - st.lastHeard;
        if (delta > NEIGHBOR_TIMEOUT) {
            console.log(
                `[TIMEOUT] Vizinho ${n} não envia mensagens há ${Math.floor(
          delta / 1000
        )}s. Rotas via ele serão removidas.`
            );
            // Não apagamos o estado; apenas deixamos o lastHeard velho.
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

// ---------------------- SOCKET UDP ----------------------

const socket = dgram.createSocket('udp4');

socket.on('error', err => {
    console.error('Erro no socket UDP:', err.message);
    socket.close();
});

socket.on('message', (msgBuf, rinfo) => {
    const msg = msgBuf.toString('utf-8').trim();
    const fromIP = rinfo.address;

    // Qualquer mensagem recebida conta como "ouviu vizinho"
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

// Trata Mensagem 1 - Anúncio de rotas
function handleRouteAnnouncement(msg, fromIP) {
    // Formato: #IP-METRICA#IP-METRICA...
    const parts = msg.split('#').filter(p => p.length > 0);
    const routes = {};

    for (const part of parts) {
        const [dest, metricStr] = part.split('-');
        const metric = parseInt(metricStr, 10);
        if (!dest || isNaN(metric)) continue;
        routes[dest] = metric;
    }

    // Atualizar estado desse vizinho
    touchNeighbor(fromIP, routes);

    // Recalcular tabela global
    const changed = recomputeRoutingTable();
    if (changed) {
        // Se causou alteração, enviar tabela imediatamente
        sendRoutingTable();
    }

    console.log(`[RECEBIDO] Anúncio de rotas de ${fromIP}:`, routes);
}

// Trata Mensagem 2 - Anúncio de roteador
function handleRouterAnnouncement(msg, fromIP) {
    // Formato: *IP
    const ip = msg.substring(1).trim();
    console.log(`[RECEBIDO] Anúncio de roteador. IP informado: ${ip} (origem: ${fromIP})`);

    if (ip && ip !== MY_IP) {
        // Considerar que aprendemos rota com métrica 1 via "fromIP"
        let st = neighborStates.get(fromIP);
        if (!st) {
            st = {
                lastHeard: nowMs(),
                routes: {}
            };
            neighborStates.set(fromIP, st);
        }
        // Do ponto de vista do vizinho, o custo até ip é 0; daqui vira 1.
        st.routes[ip] = 0;

        const changed = recomputeRoutingTable();
        if (changed) {
            sendRoutingTable();
        }
    }
}

// Trata Mensagem 3 - Mensagem de texto
function handleTextMessage(msg, fromIP) {
    // Formato: !ORIGEM;DESTINO;mensagem de texto...
    const payload = msg.substring(1); // remove '!'
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
        // Precisa encaminhar
        const route = routingTable.get(destIP);
        if (!route) {
            console.log(`[TEXTO - DESCARTE] Sem rota para ${destIP}. Mensagem descartada.`);
            console.log(`    Origem: ${srcIP}`);
            console.log(`    Destino: ${destIP}`);
            console.log(`    Texto: "${text}"\n`);
            return;
        }

        // Proteção simples contra loop: não reenviar de volta para quem acabou de mandar
        if (route.nextHop === fromIP) {
            console.log(
                `[TEXTO - LOOP] Próximo salto seria o mesmo roteador que enviou (${fromIP}). Não reenviando.`
            );
            return;
        }

        console.log(
            `[TEXTO - REPASSE] Repassando mensagem de ${srcIP} para ${destIP} via ${route.nextHop}.`
        );
        console.log(`    Texto: "${text}"\n`);

        const buf = Buffer.from(msg, 'utf-8');
        socket.send(buf, 0, buf.length, UDP_PORT, route.nextHop, err => {
            if (err) {
                console.error(`[ERRO] Falha ao encaminhar mensagem para ${route.nextHop}:`, err.message);
            }
        });
    }
}

// Envia uma mensagem de texto gerada localmente
function sendTextMessage(destIP, text) {
    const msg = `!${MY_IP};${destIP};${text}`;
    const route = routingTable.get(destIP);

    if (!route) {
        console.log(
            `[TEXTO - LOCAL] Sem rota para ${destIP}. Não foi possível enviar mensagem.`
        );
        return;
    }

    console.log(
        `[TEXTO - LOCAL] Enviando mensagem para ${destIP} via ${route.nextHop}.`
    );
    console.log(`    Texto: "${text}"\n`);

    const buf = Buffer.from(msg, 'utf-8');
    socket.send(buf, 0, buf.length, UDP_PORT, route.nextHop, err => {
        if (err) {
            console.error(`[ERRO] Falha ao enviar mensagem para ${route.nextHop}:`, err.message);
        }
    });
}

// ---------------------- INTERFACE DE LINHA DE COMANDO ----------------------

// Comandos:
//
//   msg <IP_DESTINO> <texto da mensagem...>
//   table  -> imprime a tabela de roteamento
//   help   -> mostra ajuda
//
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
                    console.log('Uso: msg <IP_DESTINO> <texto da mensagem>');
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

            case 'help':
                console.log('Comandos disponíveis:');
                console.log('  msg <IP_DESTINO> <texto>  -> envia mensagem de texto');
                console.log('  table                     -> mostra tabela de roteamento');
                console.log('  help                      -> mostra esta ajuda');
                console.log('  Ctrl+C                    -> sair');
                break;

            default:
                console.log('Comando não reconhecido. Use "help" para ajuda.');
        }

        rl.prompt();
    });
}

// ---------------------- INICIALIZAÇÃO ----------------------

loadNeighbors();

// Inicializa estado básico de vizinhos com "último contato = agora"
// para que apareçam na tabela inicialmente
const initNow = nowMs();
for (const n of neighbors) {
    if (!neighborStates.has(n)) {
        neighborStates.set(n, {
            lastHeard: initNow,
            routes: {}
        });
    }
}

// Cria tabela inicial baseada nesses vizinhos
recomputeRoutingTable();

socket.bind(UDP_PORT, () => {
    console.log(`Roteador iniciado. IP: ${MY_IP}, porta UDP: ${UDP_PORT}`);
    console.log(`Arquivo de vizinhos: ${CONFIG_FILE}`);
    printRoutingTable();

    // Envia anúncio de roteador ao entrar na rede
    sendRouterAnnouncement();

    // Envia tabela de roteamento periodicamente
    setInterval(sendRoutingTable, ROUTE_ADVERT_INTERVAL);

    // Imprime tabela periodicamente
    setInterval(printRoutingTable, PRINT_TABLE_INTERVAL);

    // Verifica timeouts de vizinhos
    setInterval(checkNeighborTimeouts, NEIGHBOR_CHECK_INTERVAL);

    // Interface de linha de comando
    setupCLI();
});