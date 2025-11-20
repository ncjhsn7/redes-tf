Autores:
Bruno Becker Silva
Luiza Hackenhaar Naziazeno
Nicolas Pietro
Sophia Mendes da Silveira


# Pré-requisitos
-> Ter o Node.js instalado no computador.

# Comando para rodar
-> node [fileName].js <ip_computador> [arquivo_de_visinhos].txt

# Estrutura do projeto
Este projeto não possui main direta, funciona através das partições socket:
- socket.on -> Que fica escutando caso receba uma mensagem
    - Ao receber a mensagem, verifica o primeiro caractere
        - Caso ! -> chama função 'handleTextMessage', que vai separar a mensagem conforme o padrão exigido, ou encaminha-la caso não seja para o seu ip.
        - Caso * -> chama função 'handleRouterAnnoucement', que vai verificar se o ip já exite na tabela, se não, o adiciona, caso haja alteração, compartilha a tabela com todos.
        - Caso # -> chama função 'handleRouteAnnoucement', que vai verificar a tabela recebida, e caso haja um ip desconhecido, o adiciona como destino e a rota se torna o ip que compartilhou a tabela.
- socket.bind -> Que inicia o servidor e chama as funções para manutençaõ da operação
    - Chama funções ao passar o tempo estipulado para:
        - sendRoutingTable -> Envio da tabela -> 15s
        - printRoutingTable -> Imprimir tabela ao usuário -> 20s
        - checkTimeouts -> Verificar tempo de comunicação dos vizinhos -> 35s
    - Há também a opção 'setupCli', utilizada para envio:
        - mensagem -> digite msg
        - verificação da tabela -> table
        - enviar anúncio de roteador online -> digite on.

