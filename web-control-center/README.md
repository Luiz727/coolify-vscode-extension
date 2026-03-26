# Control Center Web (Prototipo Fase 1)

Painel web para operacao multi-projetos em uma unica pagina, com foco em:
- abas de workspace por projeto
- grid de recursos (aplicacoes, servicos e bancos)
- acoes rapidas (start, stop, restart, deploy)
- acoes em lote (batch) por selecao de recursos
- painel de eventos/logs operacionais
- inspector de recurso com logs recentes de aplicacao (ultimo deployment)
- compare mode com dois recursos lado a lado (split view)
- trilha de auditoria persistente em JSONL
- autenticacao web opcional
- persistencia local de contexto (filtros, recursos fixados e slots do compare)

## Estrutura

- `web-control-center/frontend`: app React (Vite)
- `web-control-center/backend`: BFF em Node/Express para consumir a API do Coolify
- `docker-compose.control-center.yml`: sobe frontend + backend

## Requisitos

- Docker e Docker Compose
- URL do seu Coolify
- Token de API do Coolify (Keys & Tokens)

## Executando com Docker

1. Defina variaveis no shell:

```powershell
$env:COOLIFY_BASE_URL="https://seu-coolify.exemplo.com"
$env:COOLIFY_TOKEN="seu_token_api"

# Opcional: habilitar login web
$env:WEB_AUTH_USER="admin"
$env:WEB_AUTH_PASSWORD="troque_esta_senha"
```

2. Suba o stack:

```powershell
docker compose -f docker-compose.control-center.yml up --build -d
```

3. Abra no navegador:

- `http://localhost:8088`

4. Health check:

- `http://localhost:8088/health`

## Endpoints internos do backend

- `GET /health`
- `GET /auth/status`
- `POST /auth/login`
- `GET /api/projects`
- `GET /api/resources`
- `POST /api/actions/:resourceType/:uuid/:action`
- `POST /api/actions/batch`
- `GET /api/audit`
- `GET /api/deployments/applications/:uuid`
- `GET /api/logs/applications/:uuid/latest`
- `GET /api/logs/applications/:uuid/history`

## Observacoes

- O painel usa os mesmos endpoints principais ja usados pela extensao VS Code.
- O feed de logs e orientado a eventos operacionais e historico recente de deploy por aplicacao.
- Auditoria persistente fica em `AUDIT_LOG_PATH` no formato JSONL (uma linha JSON por evento). No compose padrao, o backend monta `./web-control-center/backend/data` em `/var/lib/control-center`.
- Quando `WEB_AUTH_USER` e `WEB_AUTH_PASSWORD` estao definidos, a API exige Bearer token gerado via `POST /auth/login`.
- Para terminal web completo em multiplas sessoes, a proxima fase deve integrar websocket/realtime com politicas de autorizacao e auditoria.
