function parseRouteMessage(msg) {
    const parts = msg.split("#").filter(p => p.length > 0);
    return parts.map(p => {
        const [ip, metric] = p.split("-");
        return { ip, metric: parseInt(metric) };
    });
}

function parseNewRouterMessage(msg) {
    return msg.substring(1);
}

function parseTextMessage(msg) {
    const parts = msg.substring(1).split(";");
    return {
        src: parts[0],
        dst: parts[1],
        text: parts.slice(2).join(";")
    };
}

module.exports = {
    parseRouteMessage,
    parseNewRouterMessage,
    parseTextMessage
};
