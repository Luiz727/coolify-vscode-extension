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
- [x] Backups de database (listar/criar/restaurar) no sidebar
- [x] `GET /api/v1/projects` e `GET /api/v1/projects/{uuid}/...` para navegação por projeto/ambiente
- [ ] Tooling de chat para services/databases (languageModelTools)
- [x] Seções dedicadas no sidebar para services/databases (paridade visual total)

## Critérios de aceite
- [x] Build/typecheck/lint passando
- [x] Testes locais passando
- [x] Comandos registrados no `package.json` e runtime
- [x] Sem regressão dos fluxos já existentes (applications/deployments/env/context)
