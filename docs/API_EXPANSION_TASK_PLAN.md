# API Expansion Task Plan (Coolify 4.x)

## Objetivo
Expandir a extensão para cobrir mais operações da API do Coolify com foco em valor operacional imediato e baixo risco.

## Fonte de referência
- Pasta local de docs: `.anexos/coolify-docs-4.x/.../docs/api-reference`
- Mapeamentos complementares: controladores API do `coollabsio/coolify` (Applications, Deploy, Services, Databases, Projects).

## Escopo desta entrega

### 1) Services API (MVP operacional) ✅
- [x] `GET /api/v1/services` (listagem)
- [x] `GET|POST /api/v1/services/{uuid}/start`
- [x] `GET|POST /api/v1/services/{uuid}/stop`
- [x] `GET|POST /api/v1/services/{uuid}/restart`
- [x] Comandos Command Palette:
  - [x] `coolify.listServices`
  - [x] `coolify.startService`
  - [x] `coolify.stopService`
  - [x] `coolify.restartService`

### 2) Databases API (MVP operacional) ✅
- [x] `GET /api/v1/databases` (listagem)
- [x] `GET|POST /api/v1/databases/{uuid}/start`
- [x] `GET|POST /api/v1/databases/{uuid}/stop`
- [x] `GET|POST /api/v1/databases/{uuid}/restart`
- [x] Comandos Command Palette:
  - [x] `coolify.listDatabases`
  - [x] `coolify.startDatabase`
  - [x] `coolify.stopDatabase`
  - [x] `coolify.restartDatabase`

### 3) Deployments API por aplicação ✅
- [x] `GET /api/v1/deployments/applications/{uuid}?skip=&take=`
- [x] Comando `coolify.listApplicationDeployments`

### 4) Robustez de payloads ✅
- [x] Tipos para `ServiceResource` e `DatabaseResource`
- [x] Guards runtime para services/databases
- [x] Parsers tipados no service layer
- [x] Testes unitários de guards atualizados

## Arquivos impactados
- `src/services/CoolifyService.ts`
- `src/utils/payloadGuards.ts`
- `src/providers/CoolifyWebViewProvider.ts`
- `src/extension.ts`
- `src/test/providerGuards.test.ts`
- `package.json`
- `CHANGELOG.md`

## Próxima onda sugerida (P2)
- [x] `GET /api/v1/services/{uuid}` detalhes completos no sidebar
- [x] `GET /api/v1/databases/{uuid}` detalhes completos no sidebar
- [x] `GET /api/v1/projects` e `GET /api/v1/projects/{uuid}/...` para navegação por projeto/ambiente
- [x] Tooling de chat para services/databases (languageModelTools)
- [x] Seções dedicadas no sidebar para services/databases (paridade visual total)

### Backups de database — correção de escopo

A entrega anterior marcava "listar/criar/restaurar" como concluída. A auditoria
mostrou que isso não correspondia à API:

- [x] Listar **agendamentos** de backup (`GET /databases/{uuid}/backups`) — a rota
      devolve configurações agendadas, não arquivos de backup.
- [x] Listar **execuções** de cada agendamento
      (`GET /databases/{uuid}/backups/{scheduled_backup_uuid}/executions`).
- [x] Criar agendamento com `frequency` obrigatório (a versão anterior enviava
      corpo vazio e recebia 422 em toda chamada).
- [x] Disparar backup imediato via `PATCH .../backups/{uuid}` com `backup_now`.
- [ ] ~~Restaurar backup~~ — **não existe na API do Coolify**. A implementação
      anterior tentava três rotas inventadas. O botão foi removido e o
      procedimento manual está documentado em `OPERATIONAL_GUIDE.md` §6.

## Onda P3 (concluída)

- [x] `GET /api/v1/applications/{uuid}/logs` — logs de runtime do container
- [x] `PATCH /api/v1/applications/{uuid}/envs/bulk` — sync de `.env` em 1 requisição
- [x] `GET /api/v1/deployments/applications/{uuid}` como fonte de histórico
- [x] `GET /api/v1/servers` + `/resources` + `/validate` — contexto de infraestrutura
- [x] Confirmação obrigatória em todas as ferramentas de escrita
- [x] Resolução estrita de alvo (sem adivinhação em operações destrutivas)

## Critérios de aceite
- [x] Build/typecheck/lint passando
- [x] Testes locais passando
- [x] Comandos registrados no `package.json` e runtime
- [x] Sem regressão dos fluxos já existentes (applications/deployments/env/context)
