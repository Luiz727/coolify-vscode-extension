# Multi-Project Control Center (Web)

## Objetivo
Criar uma experiencia web para operar varios projetos e ambientes em uma unica tela, com foco em:
- controle operacional rapido
- menor troca de contexto
- terminal e logs com alta usabilidade

## O que o Coolify original faz bem (analise)

Baseado no repositorio `coollabsio/coolify`:

1. Modelo de navegacao por contexto
- Rotas orientadas a `project_uuid` + `environment_uuid` + `resource_uuid`.
- Exemplo: aplicacao, servico e banco abrem em paginas separadas por recurso.
- Bom para foco local, mas aumenta troca de contexto para quem opera varios projetos ao mesmo tempo.

2. Logs robustos no recurso atual
- Componente de logs com stream, filtro, busca, fullscreen, copy/download.
- Historico de deploy com pesquisa no log e follow mode.
- Boa base funcional, porem distribuida em varias telas.

3. Terminal funcional, mas separado
- Terminal via websocket/realtime em fluxo dedicado.
- Excelente para uma sessao por vez, menos eficiente para comparar varios alvos simultaneamente.

4. Organizacao por projeto/ambiente
- Entidades e UX reforcam a hierarquia Team -> Project -> Environment -> Resource.
- Existe troca rapida por dropdown/breadcrumb, mas ainda dentro de uma unica trilha de navegação.

## Gap de usabilidade para seu caso
Voce precisa de operacao paralela: monitorar/controlar varios projetos sem perder contexto.

Principais dores que a tela unica resolve:
- alternancia excessiva entre paginas
- logs e terminais nao comparaveis lado a lado
- acao em lote (deploy/restart/check) pouco fluida

## Proposta: pagina unica "Control Center"

## Layout sugerido
1. Barra superior (global)
- seletor de contexto (server/team)
- busca global
- quick actions (deploy em lote, restart em lote)
- indicador de eventos ativos

2. Coluna esquerda (catalogo)
- arvore com Project -> Environment -> Resources
- filtros por status, tag, tipo, criticidade
- favoritos e "pinned resources"

3. Area central com abas
- cada aba representa um "workspace" (ex.: Projeto A/Prod)
- cada workspace pode abrir sub-abas: Overview, Logs, Terminal, Deployments
- abas fixas + abas temporarias (como browser)

4. Painel direito (inspector)
- status consolidado do item selecionado
- ultimos deploys
- acoes rapidas start/stop/restart/deploy

## Modos-chave da pagina
1. Fleet mode
- cards compactos de varios projetos e ambientes
- sem entrar em detalhe, foco em saude/status e acoes em lote

2. Compare mode
- split view 2 ou 3 colunas
- comparar logs/terminal entre ambientes/projetos

3. Incident mode
- timeline unica com eventos (deploys, falhas, restart, status changes)
- filtros por projeto/tag/servico

## Terminal e Logs (foco da UX)

## Logs
- tail em tempo real por recurso
- multiplex: agregar varios recursos no mesmo painel com prefixo
  - formato: `[projeto/env/recurso] mensagem`
- filtros salvos por severidade/tag/texto
- bookmark de linhas e "share link" com query aplicada
- pausar stream sem perder buffer

## Terminal
- sessoes em abas (uma por recurso)
- reconexao automatica e estado visivel
- historico local de comandos por recurso
- templates de comando (playbooks operacionais)
- modo "broadcast" opcional para executar em multiplos alvos com confirmacao forte

## Como isso conversa com a API do Coolify

## Endpoints uteis ja existentes
- projetos e ambientes: `/api/v1/projects` e variacoes por uuid
- recursos agregados: endpoints de applications/services/databases/resources
- deploys: endpoints de deployments

## Nota importante sobre terminal
No Coolify original, terminal web usa fluxo websocket/realtime e autorizacao de sessao/cookies para hosts permitidos.
Para sua versao web externa, existem 2 caminhos:
1. Integracao nativa com o realtime do Coolify (mais proximo do comportamento original, maior complexidade).
2. Terminal proprio (gateway SSH controlado pela sua aplicacao), com politicas de acesso e auditoria.

Recomendacao inicial: iniciar por logs + acoes operacionais + deploys, e introduzir terminal em fase seguinte para reduzir risco.

## Roadmap de implementacao (incremental)

## Fase 1 (MVP operacional)
- pagina unica com:
  - lista de projetos/ambientes
  - painel de recursos por status
  - acoes start/stop/restart/deploy
  - stream de logs de um recurso por vez
- abas de workspace (sem split)
- favoritos/pinned resources

## Fase 2 (produtividade)
- logs multiplex
- split view com 2 paineis
- acao em lote por filtro/tag
- timeline de eventos/deploys

## Fase 3 (terminal avancado)
- terminal em abas
- reconexao robusta
- templates de comando
- opcional: broadcast controlado

## Arquitetura sugerida para sua versao web
- Frontend: React + Vite
- Backend BFF: Node.js (Fastify) para normalizar chamadas e segredos
- Realtime: websocket dedicado para logs/terminal
- Cache: Redis para snapshots de status e buffers curtos de logs
- Deploy: Docker Compose (local) e depois no proprio Coolify

## Modelo de dados de frontend (visao)
- WorkspaceTab: contexto atual (project/environment), layout, filtros
- ResourceView: item ativo, status, ultimos eventos, acoes disponiveis
- LogStreamState: fonte, filtros, cursor, pause/follow
- TerminalSessionState: target, conexao, buffer, historico, reconnect

## Sinais de qualidade (aceitacao)
- abrir e alternar 5+ projetos sem perder estado de abas
- executar acoes em lote com feedback por item
- logs com latencia baixa e sem travar UI
- persistencia de layout/filtros por usuario
- auditoria minima: quem executou o que e quando

## Conexao com este repositorio
Este repositorio ja cobre operacoes essenciais via API (apps/services/databases/deployments) e e uma base excelente para o BFF/web.
A evolucao natural e extrair/reaproveitar o nucleo de chamadas e validacoes para um modulo compartilhado entre extensao e web.

## Proximo passo recomendado
Implementar um prototipo de `Control Center` com:
1. grid de recursos multi-projeto
2. drawer de logs em tempo real
3. abas de workspace
4. acoes rapidas por recurso

Com isso, voce valida rapidamente usabilidade real antes de investir no terminal completo.
