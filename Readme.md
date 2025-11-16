# Fluxo do Programa - Roteador UDP

## 1 - Inicialização
1. Ler arquivo de configuração (`roteadores.txt`) para identificar vizinhos.
2. Inicializar a tabela de roteamento:
   - Cada vizinho do arquivo é adicionado com:
     - Métrica = 1
     - Próximo salto = IP do vizinho
     - Estado = HOLD
3. Inicializar a lista de vizinhos (`neighborStates`) com estado HOLD.

## 2 - Configuração do Socket UDP
1. Criar socket UDP e bind na porta configurada.
2. Configurar eventos:
   - `message`: tratar mensagens recebidas.
   - `error`: log de erro no socket.

## 3 - Envio inicial de anúncios
1. Enviar mensagem de anúncio de roteador: `*<MEU_IP>` para todos os vizinhos.
2. Este anúncio ativa vizinhos desconhecidos:
   - Estado do vizinho passa de HOLD → ACTIVE.
   - Inicia contagem de 35s para timeout.

## 4 - Timers periódicos
1. `ROUTE_ADVERT_INTERVAL`: enviar tabela de roteamento (`#IP-Métrica`) para vizinhos.
2. `PRINT_TABLE_INTERVAL`: imprimir tabela de roteamento.
3. `NEIGHBOR_CHECK_INTERVAL`: verificar vizinhos para timeout de 35s.

## 5 - Recebimento de mensagens UDP

### 5.1 - Mensagens `*IP` (anúncio de roteador)
1. Identifica IP do vizinho.
2. Se vizinho novo:
   - Adiciona à lista de vizinhos.
   - Estado = ACTIVE
   - Métrica = 1, próximo salto = ele mesmo
3. Se vizinho já existente:
   - Atualiza `lastHeard`
   - Estado → ACTIVE
4. Recalcular tabela de roteamento:
   - Mantém vizinhos ativos
   - Ignora vizinhos em HOLD
5. Envia tabela se houver mudanças.

### 5.2 - Mensagens `#IP-Métrica` (anúncio de rotas)
1. Para cada rota recebida:
   - Se destino não existe na tabela local:
     - Adicionar destino.
     - Métrica = métrica recebida + 1
     - Próximo salto = IP do vizinho que enviou
   - Se destino existe e métrica recebida + 1 < métrica atual:
     - Atualizar métrica e próximo salto
   - Se destino deixar de ser divulgado:
     - Remover rota da tabela
2. Atualizar `lastHeard` do vizinho.
3. Atualizar vizinho para ACTIVE.
4. Recalcular tabela de roteamento.
5. Imprimir alterações.

### 5.3 - Mensagens `!IP_ORIGEM;IP_DESTINO;Texto`
1. Se destino = meu IP:
   - Imprimir mensagem recebida.
2. Se destino != meu IP:
   - Buscar próximo salto na tabela de roteamento.
   - Se não houver rota → descartar.
   - Se próximo salto = IP de origem da mensagem → evitar loop.
   - Senão → repassar mensagem via UDP para próximo salto.

## 6 - Gerenciamento de vizinhos
1. Vizinhos em HOLD:
   - Não são considerados ativos.
   - Não contam timeout.
   - Não aparecem na tabela de roteamento ativa.
2. Vizinhos ativos (receberam `*` ou `#`):
   - Contagem de 35s iniciada a partir do último `lastHeard`.
   - Se passar 35s sem mensagens:
     - Estado → INACTIVE
     - Remover vizinho da lista.
     - Remover todas as rotas que passam por ele ou que têm ele como destino.
3. Qualquer atualização de vizinho ativa recalcula a tabela de roteamento e envia anúncios.

## 7 - Impressão da tabela de roteamento
1. Para cada destino na tabela:
   - Imprimir: Destino, Métrica, Próximo salto, Estado
2. Se tabela vazia → imprimir `(vazia)`.

## 8 - CLI (linha de comando)
1. `msg <IP_DESTINO> <texto>` → enviar mensagem de texto via tabela de roteamento.
2. `table` → imprimir tabela de roteamento.
3. `n` → imprimir vizinhos e status (HOLD, ACTIVE, INACTIVE).
4. `send` → enviar tabela de roteamento manualmente.
5. `help` → listar comandos.
6. `Ctrl+C` → encerrar roteador.

## 9 - Resumo do ciclo de roteador
1. Recebe mensagens UDP → atualiza vizinhos e tabela.
2. Vizinhos ativos → suas rotas propagadas via `#IP-Métrica`.
3. Timeout de vizinhos → remoção após 35s sem comunicação.
4. CLI permite interação manual com envio de mensagens e visualização da tabela.
