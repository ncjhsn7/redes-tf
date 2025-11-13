class RoutingTable {
    constructor(myIP, neighbors) {
        this.myIP = myIP;
        this.table = {};

        neighbors.forEach(ip => {
            this.table[ip] = { metric: 1, via: ip };
        });
    }

    addDirectNeighbor(ip) {
        if (!this.table[ip]) {
            this.table[ip] = { metric: 1, via: ip };
            console.log("Novo vizinho adicionado:", ip);
        }
    }

    getNextHop(dst) {
        if (!this.table[dst]) return null;
        return this.table[dst].via;
    }

    serializeForSend() {
        let str = "";
        for (const dst in this.table) {
            if (dst === this.myIP) continue;
            str += `#${dst}-${this.table[dst].metric}`;
        }
        return str;
    }

    updateFromNeighbor(fromIP, routes) {
        let changed = false;

        const receivedIPs = routes.map(r => r.ip);

        // 1) Adicionar ou melhorar rotas
        routes.forEach(r => {
            const newMetric = r.metric + 1;

            if (!this.table[r.ip]) {
                this.table[r.ip] = { metric: newMetric, via: fromIP };
                changed = true;
            } else if (newMetric < this.table[r.ip].metric) {
                this.table[r.ip] = { metric: newMetric, via: fromIP };
                changed = true;
            }
        });

        // 2) Remover destinos que desapareceram
        for (const ip in this.table) {
            if (this.table[ip].via === fromIP && !receivedIPs.includes(ip)) {
                delete this.table[ip];
                changed = true;
            }
        }

        return changed;
    }

    removeRoutesVia(ip) {
        let changed = false;
        for (const dst in this.table) {
            if (this.table[dst].via === ip) {
                delete this.table[dst];
                changed = true;
            }
        }
        return changed;
    }

    print() {
        console.log("\n==== TABELA DE ROTEAMENTO ====");
        for (const ip in this.table) {
            const r = this.table[ip];
            console.log(`${ip}    Métrica: ${r.metric}    Saída: ${r.via}`);
        }
        console.log("================================\n");
    }
}

module.exports = { RoutingTable };
