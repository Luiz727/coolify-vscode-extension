# Change Log

All notable changes to the "vscode-coolify" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Auditoria de confiabilidade — correções

**Segurança**

- Chat/IA: toda ferramenta que altera estado agora exige confirmação explícita do
  usuário, nomeando recurso, ação e contexto ativo.
- Chat: corrigido roteamento de intenção que fazia "listar deployments" cair no
  ramo de deploy — com uma única aplicação cadastrada, isso disparava um deploy
  real em produção.
- Chat/IA: resolução de alvo passou a ser estrita em operações de escrita. Um id
  inexistente é erro (antes caía para busca por nome e depois para "a única
  aplicação"); um nome parcial ambíguo lista os candidatos em vez de escolher o
  primeiro entre `api-prod` e `api-staging`.
- Control Center: autenticação passou a ser obrigatória — o backend recusa iniciar
  sem credenciais, em vez de subir aberto quando as variáveis estavam vazias.
- Control Center: token de sessão passou a ser aleatório com expiração; antes era
  `base64(usuário:senha)`, ou seja, a própria credencial em forma reversível.
- Control Center: senha armazenada como hash scrypt, comparação em tempo constante
  e limite de tentativas de login.
- Control Center: porta 8088 deixou de ser publicada no host; acesso apenas via
  Traefik com HTTPS.
- Control Center: ator da auditoria passou a vir da sessão, não de um cabeçalho
  preenchido pelo próprio navegador.
- Extensão: um 401 transitório não apaga mais o token salvo; o usuário decide se
  quer reconfigurar.

**Correção de uso da API**

- Deployments: a lista passou a combinar execuções em andamento com o histórico
  por aplicação. `GET /deployments` retorna apenas o que está rodando naquele
  instante, então a seção ficava vazia na operação normal.
- Deployments: identidade unificada pelo `deployment_uuid`. Cancelar deployment e
  abrir detalhes usavam o id numérico e falhavam com 404 silencioso.
- Variáveis de ambiente: removidos `is_buildtime` e `is_runtime` dos corpos de
  criação/atualização — a API rejeita campos desconhecidos com 422, o que fazia
  toda criação de variável falhar.
- Variáveis de ambiente: sync de `.env` passou a usar `PATCH /envs/bulk` em uma
  requisição, no lugar de N requisições sequenciais.
- Backups: substituídos por agendamentos e execuções, que é o que a API oferece.
  `POST /backups` exige `frequency` (era enviado sem corpo → 422 sempre) e o botão
  de restaurar foi removido: **a API do Coolify não tem rota de restore** — a
  versão anterior tentava três endereços inexistentes.
- Logs: `GET /applications/{uuid}/logs` (logs de runtime do container) passou a ser
  usado; antes só existiam logs de build.
- Logs de deployment: decodificados do array JSON serializado do Coolify, em vez
  de exibidos crus.

**Status e cálculos**

- Taxonomia única de status entre extensão e painel web, documentada em
  `docs/STATUS_TAXONOMY.md`. `running:unhealthy` agora é **degradado**, não
  "rodando" — antes aparecia verde no site e com problema no editor.
- Corrigida inversão de saúde: `"unhealthy".includes("healthy")` é verdadeiro, e o
  teste positivo vinha primeiro, classificando recursos doentes como saudáveis.
- Estados `restarting`, `degraded`, `paused`, `dead`, `created` e `removing`
  deixaram de cair em "desconhecido".
- Painel web: contagem passou a exibir todos os buckets mais o total — a soma dos
  cartões não fechava com o número de recursos.
- Painel web: ordenação invertida para mostrar problemas primeiro.
- Painel web: filtro por projeto voltou a funcionar. O backend lia `project_name`,
  campo que a API não retorna, então selecionar um projeto zerava o grid.

**Confiabilidade e desempenho**

- Deploy deixou de ser repetido automaticamente: `withRetry` envolvia
  `startDeployment`, e um timeout de 10s podia enfileirar dois ou três deploys.
- Retry deixou de reexecutar erros não classificados (normalmente bugs próprios).
- Corrigido vazamento de listeners: os handlers de visibilidade e descarte eram
  acumulados a cada `updateView()`.
- Polling reduzido e com backoff exponencial; pausa quando a aba/painel não está
  visível. Cache compartilhado de 5s no backend web.
- Auditoria passou a ser servida de um buffer em memória com rotação por tamanho,
  em vez de reler o arquivo inteiro a cada 12 segundos.

**Novidades**

- Seção de servidores (extensão e web) com acessibilidade, contagem de falhas de
  conexão, alerta de disco e recursos hospedados — responde por que vários
  recursos caem ao mesmo tempo.
- Monitoramento de VPS via API da Hostinger: CPU, memória, disco, rede e uptime,
  correlacionados ao servidor do Coolify pelo IP. Operações de energia, snapshot e
  restauração exigem digitação do hostname, exibição do raio de impacto e
  reconhecimento explícito de perda de dados. Ver `docs/VPS_MONITORING.md`.
- Histórico opcional em Postgres: uptime, MTTR, taxa de sucesso de deploy e
  detecção de recurso instável. Sem a variável de ambiente, o painel opera
  normalmente sem métricas acumuladas.
- Ferramentas de IA ampliadas de 12 para 21, cobrindo logs de runtime, variáveis
  de ambiente, histórico de deployments, projetos, servidores e backups.
  Exclusões continuam fora do alcance da IA.
- Confirmação obrigatória para ações em lote no painel web.
- Indicador de dado velho: quando a atualização falha, a tela avisa o horário do
  último dado bom em vez de exibi-lo como atual.

### Anterior

- UX: commands are now discoverable in Command Palette even before opening the sidebar.
- UX: added explicit `onCommand` activation events for all Coolify commands.
- Security: enforce HTTPS by default during server configuration.
- Security: add `coolify.allowInsecureHttp` setting (disabled by default) for explicit HTTP opt-in.
- Security: harden Webview with CSP + nonce and safer DOM rendering.
- Reliability: introduce typed HTTP client with timeout and API error classification.
- Reliability: improve user-facing error handling for auth/network/server failures.
- Reliability: apply selective retry strategy (retry only transient timeout/network/5xx errors).
- Tests: add unit tests for URL validation/normalization and HTTP client error classification.
- Feature: add command palette actions to list deployments and open deployment details.
- Feature: add command palette action to cancel deployments with confirmation.
- Feature: add command palette action to open deployment logs.
- Feature: add command palette actions to start, stop, and restart applications.
- Feature: add language selection (`en` / `pt-BR`) with translated webview and welcome screen.
- Observability: add `Coolify Extension` output channel with structured logs and secret redaction.
- Observability: add `coolify.logLevel` setting and `Coolify: Show Logs` command.
- Feature: add multi-context management (`create`, `switch`, `delete`) with active context aware configuration.
- Feature: add context selector directly in sidebar (webview) for quick context switching.
- Feature: add application environment variables CRUD commands (list/create/update/delete).
- Feature: add sidebar actions for env vars per application (`Envs` and `Add Env`).
- UX: add inline env vars panel in sidebar with direct per-variable edit/delete actions.
- UX: add deployments filters in sidebar (status + application name) with persisted state.
- UX: add status bar indicator for active context with quick context switching.
- UX: add `Open` action in sidebar cards to open application/deployment URLs in browser when available.
- Feature: add `.env` sync flow with diff preview (add/update/full-sync) and conflict resolution strategy by key (`.env` vs remote).
- Feature: add setting `coolify.envSyncConflictStrategy` to persist default conflict strategy for `.env` sync.
- UX: add command `Coolify: Set Env Sync Conflict Strategy` for quick strategy changes from Command Palette.
- UX: add sidebar selector for env sync conflict strategy, synchronized with global setting.
- CI: add GitHub Actions workflow running typecheck, lint, compile-tests and test on push/PR.
- Tests: add mocked integration coverage for `CoolifyService` endpoints used by deployments/lifecycle/env vars.
- CI: add coverage gate (`test:coverage`) with initial baseline thresholds for lines/functions/branches/statements.
- Tests: replace sample extension test with real contribution/command registration assertions.
- Architecture: replace `any[]` API mapping paths in webview provider with explicit typed models from `CoolifyService`.
- Architecture: add typed list-item mappers and safer deployment date sorting to reduce shape/date assumptions in provider reads.
- Reliability: add runtime guards for applications/deployments payload items and ignore invalid entries with warning logs.
- Reliability: align `languageModelTools` IDs to VS Code naming rules (`[\w-]+`) to avoid runtime registration warnings.
- Security: centralize display-text sanitization in provider mappings before sending data to webview.
- Architecture: validate API payload shapes in `CoolifyService` (arrays/objects) with typed guards before exposing data to provider/tools.
- Architecture: add explicit UI state machine (`unconfigured`, `loading`, `ready`, `error`) with provider-driven transitions and webview state feedback banner.
- UX: add context operation actions in sidebar (`create`, `delete`, `configure`, `reconfigure`) to close operational parity with Command Palette.
- Docs: add operational guide with support matrix, troubleshooting playbook, and expanded security guidance.
- Feature: expand Coolify API surface with services/databases lifecycle commands and application deployment history listing.
- UX: add sidebar sections for services and databases with inline start/stop/restart actions.
- UX: add on-demand service details panel in sidebar cards (`Details`) using `GET /api/v1/services/{uuid}`.
- UX: add on-demand database details panel in sidebar cards (`Details`) using `GET /api/v1/databases/{uuid}`.
- Feature: add database backups actions in sidebar (`Backups`, `Create backup`, `Restore`) with API fallback strategy.
- Feature: add projects section in sidebar with on-demand project details and environment visibility (`GET /api/v1/projects`, `GET /api/v1/projects/{uuid}`).
- Feature: add Copilot Configure Tools for services/databases (list + start/stop/restart lifecycle actions).
- Chat: padroniza descrições de `languageModelTools` em PT-BR e melhora schemas para reduzir ambiguidade de parâmetros.
- Chat: amplia `@coolify` com exemplos e intents para serviços/bancos (listar, status e lifecycle).
- Docs: add security notes for transport configuration.