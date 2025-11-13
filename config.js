const fs = require("fs");

function loadConfig(path) {
    if (!fs.existsSync(path)) {
        console.log("Arquivo de configuração não encontrado.");
        process.exit(1);
    }

    const lines = fs.readFileSync(path, "utf8")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0);

    return lines;
}

module.exports = { loadConfig };
