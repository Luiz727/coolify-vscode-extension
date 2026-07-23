# Control Center Web

Painel de operação multi-projetos em uma única página, com:

- grid de recursos (aplicações, serviços e bancos) agrupados por projeto/ambiente
- ações rápidas (start, stop, restart, deploy) **com confirmação**
- ações em lote com confirmação proporcional ao impacto
- inspector com logs do container ao vivo e do último deployment
- compare mode com dois recursos lado a lado
- painel de servidores e métricas de VPS (CPU/RAM/disco/rede)
- trilha de auditoria persistente
- histórico opcional com uptime, MTTR e taxa de sucesso de deploy

## Estrutura

- `frontend/` — app React (Vite)
- `backend/` — BFF em Node/Express que fala com a API do Coolify
- `../docker-compose.control-center.yml` — sobe frontend + backend

## Segurança: leia antes de subir

Este painel opera **todo o seu Coolify**: quem alcança a tela pode parar, reiniciar
e fazer deploy de qualquer recurso. Por isso:

- **O backend se recusa a iniciar sem credenciais.** Não existe modo aberto.
- **O frontend não publica porta no host.** O acesso é só via Traefik com HTTPS.
- A sessão usa token aleatório com expiração, guardado em memória no servidor.
- O usuário da auditoria vem da sessão, não de um cabeçalho enviado pelo navegador.

## Configuração

1. Copie o exemplo e preencha:

```bash
cp .env.control-center.example .env
```

2. Gere o hash da senha (nunca use senha em texto puro em produção):

```bash
cd web-control-center/backend
npm install
npm run hash-password -- "sua-senha-forte-aqui"
```

Copie a linha `WEB_AUTH_PASSWORD_HASH=...` para o `.env`.

3. Preencha no mínimo:

```bash
COOLIFY_BASE_URL=https://coolify.seudominio.com
COOLIFY_TOKEN=seu_token_api
WEB_AUTH_USER=admin
WEB_AUTH_PASSWORD_HASH=scrypt$...
```

## Subindo

```bash
docker compose -f docker-compose.control-center.yml up --build -d
```

Acesso pelo domínio configurado no Traefik (`control.nixcon.com.br` no compose
padrão — ajuste os labels para o seu domínio).

### Desenvolvimento local

Só para desenvolvimento, o override publica a porta em `127.0.0.1`:

```bash
docker compose -f docker-compose.control-center.yml \
               -f docker-compose.control-center.dev.yml up --build
```

Não use esse override no VPS.

## Recursos opcionais

Ambos degradam de forma limpa: sem a variável, o recurso simplesmente não aparece
e o resto do painel funciona normalmente.

### Histórico e métricas

```bash
HISTORY_DATABASE_URL=postgres://usuario:senha@host:5432/control_center
```

Provisione um Postgres pelo próprio Coolify. O schema é criado automaticamente.
Habilita `GET /api/metrics` com uptime por recurso, MTTR, taxa de sucesso de deploy
e detecção de recurso instável (flapping). Retenção padrão de 90 dias
(`HISTORY_RETENTION_DAYS`).

### Monitoramento de VPS

```bash
HOSTINGER_API_TOKEN=seu_token_hostinger
```

Ver [docs/VPS_MONITORING.md](../docs/VPS_MONITORING.md) — inclui a correlação por
IP entre servidor do Coolify e máquina da Hostinger, os limiares de alerta e o
procedimento das operações irreversíveis.

## Endpoints do backend

| Rota | Descrição |
|---|---|
| `GET /health` | Saúde do próprio backend (sem autenticação) |
| `POST /auth/login` · `POST /auth/logout` | Sessão |
| `GET /api/session` | Usuário da sessão atual |
| `GET /api/projects` · `GET /api/resources` | Catálogo |
| `GET /api/servers` | Servidores do Coolify com sinais de causa raiz |
| `POST /api/actions/:type/:uuid/:action` | Ação individual |
| `POST /api/actions/batch` | Ação em lote (máx. 50) |
| `GET /api/audit` | Trilha de auditoria |
| `GET /api/deployments/applications/:uuid` | Histórico de deployments |
| `GET /api/logs/applications/:uuid/runtime` | Logs do container ao vivo |
| `GET /api/logs/applications/:uuid/latest` · `/history` | Logs de deployment |
| `GET /api/metrics` | Uptime, MTTR, taxa de deploy (requer histórico) |
| `GET /api/vps` · `/:vmId/metrics` · `/:vmId/blast-radius` | VPS (requer Hostinger) |
| `POST /api/vps/:vmId/power/:action` | Energia da VPS (travas de confirmação) |
| `POST /api/vps/:vmId/snapshot[/restore]` | Snapshot (restore é irreversível) |

Todas as rotas sob `/api` exigem `Authorization: Bearer <token>`.

## Testes

```bash
cd backend && npm test
```

## Observações

- A auditoria fica em `AUDIT_LOG_PATH` (JSONL), com rotação automática por tamanho
  e leitura servida de um buffer em memória.
- O backend mantém cache de 5s por rota do Coolify: vários operadores com o painel
  aberto não multiplicam a carga no VPS.
- O polling pausa quando a aba está oculta e aplica backoff exponencial em erro.
- Status segue a taxonomia única documentada em
  [docs/STATUS_TAXONOMY.md](../docs/STATUS_TAXONOMY.md) — em particular,
  `running:unhealthy` é **degradado**, não "rodando".
