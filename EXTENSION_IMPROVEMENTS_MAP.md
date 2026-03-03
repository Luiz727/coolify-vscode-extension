# Mapeamento Completo de Melhorias — Coolify VS Code Extension

## 1) Objetivo deste documento

Este documento mapeia, de forma prática e priorizada, tudo que pode ser melhorado na extensão para:

- aumentar segurança e confiabilidade;
- expandir cobertura funcional (aproximando do `coolify-cli` quando fizer sentido);
- melhorar UX no VS Code;
- elevar qualidade de engenharia (testes, CI, release, manutenção).

---

## 2) Estado atual (baseline)

### Funcionalidades existentes

- Configuração de URL e token do Coolify.
- Validação inicial de conexão/token.
- Listagem de aplicações.
- Listagem de deployments ativos.
- Disparo de deployment por aplicação.
- Atualização periódica da UI (polling).

### Características técnicas observadas

- Comunicação via `fetch` direto com endpoints da API Coolify.
- Token salvo em `SecretStorage` do VS Code.
- UI em Webview com templates HTML locais.
- Sem telemetria explícita.
- Sem testes funcionais reais (apenas teste de exemplo).

### Gap geral vs `coolify-cli`

A extensão é hoje um **painel de deploy**. O CLI é um **cliente completo de administração** (contextos, servidores, projetos, recursos, apps, env vars, logs, bancos, serviços, deployments avançados, integrações GitHub, times, chaves, etc.).

---

## 3) Melhorias críticas (P0)

## P0.1 — Segurança de transporte (HTTPS obrigatório por padrão)

**Problema**
A URL aceita `http://`, o que pode expor token Bearer em rede não confiável.

**Melhoria**
- Exigir `https://` por padrão.
- Permitir `http://` apenas com opt-in explícito em setting (`coolify.allowInsecureHttp`) + warning forte.
- Exibir aviso visual persistente na UI quando estiver em modo inseguro.

**Critério de aceite**
- Sem opt-in, configuração com `http://` é bloqueada.
- Com opt-in, fluxo funciona e usuário vê aviso explícito.

---

## P0.2 — Hardening da Webview (XSS)

**Problema**
Uso de `innerHTML` com dados vindos da API aumenta risco de injeção.

**Melhoria**
- Substituir renderização por criação de nós DOM com `textContent`.
- Escapar/normalizar strings vindas da API.
- Adotar Content Security Policy (CSP) estrita em todos os templates.
- Evitar inline script quando possível (migrar para script externo com nonce).

**Critério de aceite**
- Nenhum dado remoto é inserido com `innerHTML` sem sanitização.
- CSP ativa e validada para templates.

---

## P0.3 — Camada de API robusta

**Problema**
Erros de rede e API têm tratamento limitado; faltam timeout/cancelamento e tipagem forte de erro.

**Melhoria**
- Criar cliente HTTP interno com:
  - timeout padrão;
  - retry com backoff apenas para erros transitórios;
  - classificação de erro (auth, permissão, indisponível, inválido);
  - mensagens de erro amigáveis no VS Code.
- Centralizar headers/autorização/log seguro.

**Critério de aceite**
- Erros 401/403/5xx e timeout exibem mensagens específicas.
- Operações longas podem ser canceladas.

---

## P0.4 — Testes mínimos de verdade

**Problema**
Não há cobertura real de comportamento da extensão.

**Melhoria**
- Testes unitários para:
  - validação/normalização de URL;
  - mapeamento de dados API → UI;
  - regras de retry/backoff;
  - gerenciamento de configuração/segredos.
- Testes de integração (mock API) para fluxo: configurar → listar apps → deploy.

**Critério de aceite**
- Cobertura mínima de módulos críticos (ex.: 70% em serviços/utilitários).
- Pipeline falha se testes críticos falharem.

---

## 4) Melhorias importantes (P1)

## P1.1 — Evolução funcional por módulos (paridade parcial com CLI)

### Módulo Apps
- `app get` (detalhes completos).
- Start/Stop/Restart além de Deploy.
- Logs da aplicação.
- Histórico de deployments por app.

### Módulo Deployments
- `deploy list/get` completo.
- Cancelamento de deployment em andamento.
- Filtro por status/aplicação.

### Módulo Environment Variables
- Listar/criar/editar/remover variáveis para app.
- Fluxo de sync por arquivo `.env` (com pré-visualização de diff).

### Módulo Resources/Projects
- Listar recursos agregados.
- Navegar projetos/ambientes e filtrar apps por contexto.

**Critério de aceite**
- Cada módulo entregue com comandos de palette + ações no webview.

---

## P1.2 — Multi-contexto (inspirado no CLI)

**Problema**
Hoje parece haver apenas um servidor/token por vez.

**Melhoria**
- Suporte a múltiplos contextos nomeados (`prod`, `staging`, `dev`).
- Troca rápida de contexto no status bar.
- Contexto default + override por comando.

**Critério de aceite**
- Usuário alterna contexto sem reconfigurar token toda hora.

---

## P1.3 — UX e produtividade

- Comandos mais granulares na Command Palette.
- QuickPick com busca/filtro e atalhos.
- Indicadores de loading/erro por seção.
- Confirmação para operações destrutivas.
- Mensagens de sucesso/erro mais orientadas a ação.
- Botão de “abrir no Coolify” (recurso selecionado).
- Regra de paridade UX: toda função operacional nova deve ter ação equivalente no sidebar (webview), não apenas na Command Palette.

**Critério de aceite**
- Fluxos principais sem ambiguidade e sem “silêncio” em erro.
- Funções críticas (deploy, lifecycle, logs, cancelamento, detalhes) acessíveis diretamente no sidebar com feedback visual.

---

## P1.4 — Observabilidade interna da extensão

- Canal de output dedicado (`Coolify Extension`).
- Logs estruturados com níveis (`debug`, `info`, `warn`, `error`).
- Redação de segredos em logs.
- Setting para habilitar debug sem recompilar.

**Critério de aceite**
- Troubleshooting possível sem expor token/sensíveis.

---

## 5) Melhorias de médio prazo (P2)

## P2.1 — Recursos avançados de operações

- Ações em lote (deploy batch por seleção).
- Auto-refresh configurável (intervalo, pause on hidden).
- Notificações de status (quando deployment termina/falha).
- Histórico local de operações recentes (somente metadados não sensíveis).

---

## P2.2 — Suporte parcial a entidades avançadas do Coolify

- Serviços (`service list/get/start/stop/restart`).
- Banco de dados (`database list/get/start/stop/restart`).
- Time/organização em leitura.

> Observação: criação/remoção de recursos sensíveis deve entrar só após UX de confirmação robusta.

---

## P2.3 — Internacionalização e acessibilidade

- i18n (pt-BR/en-US) para textos da UI.
- Navegação por teclado no webview.
- Semântica de aria labels e contraste.

---

## 6) Melhorias de arquitetura

## A. Separação de camadas

- `api/` (client HTTP + contratos)
- `domain/` (casos de uso)
- `presentation/` (provider + webview state)
- `infrastructure/` (config, storage, logging)

Benefício: mais testável, menos acoplado ao WebviewProvider.

## B. Tipagem de modelos

- Eliminar `any[]` em mapeamentos.
- Interfaces de resposta por endpoint.
- Validar shape mínimo de resposta (guardas de runtime).

## C. Máquina de estado da UI

- Estados explícitos: `unconfigured`, `loading`, `ready`, `error`.
- Menos lógica ad-hoc em callbacks.

---

## 7) Segurança e conformidade

- Sanitização centralizada para conteúdo exibido.
- Revisão de permissões/contribuições no `package.json`.
- Política de dependências (SCA, update automatizado, lockfile estável).
- Threat model simples documentado (ativos, vetores, mitigação).
- Guia de resposta a incidente (token comprometido, endpoint suspeito).

---

## 8) Testes, CI/CD e qualidade

## Testes
- Unitários por módulo crítico.
- Integração com mock da API Coolify.
- Snapshot/DOM tests para webview (quando aplicável).

## CI
- `lint` + `typecheck` + `test` obrigatórios em PR.
- Relatório de cobertura e badge.
- Build da extensão em PR para validar empacotamento.

## Release
- Versionamento semântico e changelog real por versão.
- Checklist de release (segurança + regressão).

---

## 9) Documentação que falta

- Matriz clara de funcionalidades suportadas vs não suportadas.
- Guia de segurança (HTTPS, token scopes, boas práticas).
- Troubleshooting (timeouts, 401, host inválido, CORS/proxy).
- FAQ para self-hosted e Cloud.

---

## 10) Roadmap sugerido (90 dias)

## Fase 1 (Semanas 1–3) — Hardening + base técnica
- HTTPS por padrão + opt-in inseguro.
- Remoção de `innerHTML` inseguro + CSP.
- Cliente HTTP com timeout/erros tipados.
- Testes unitários base.

## Fase 2 (Semanas 4–7) — Funcionalidade principal
- App details + start/stop/restart + logs.
- Deployments list/get/cancel.
- Melhorias de UX e feedback.

## Fase 3 (Semanas 8–10) — Multi-contexto + env vars
- Contextos nomeados e troca rápida.
- CRUD básico de env vars + sync `.env` com preview.

## Fase 4 (Semanas 11–13) — Qualidade e release
- Cobertura/CI robusta.
- Documentação de segurança e troubleshooting.
- Release estável com changelog completo.

---

## 11) Backlog executável (resumo)

## Segurança (alta prioridade)
- [ ] Forçar HTTPS por padrão.
- [ ] CSP + remoção de `innerHTML` inseguro.
- [ ] Sanitização centralizada.

## Core técnico
- [ ] Cliente API com timeout/retry/classificação de erro.
- [ ] Tipagem estrita de respostas.
- [ ] Estado da UI explícito.

## Produto
- [ ] App details + lifecycle completo.
- [ ] Deployments avançados (get/cancel/logs).
- [ ] Multi-contexto.
- [ ] Env vars CRUD + sync.
- [ ] Paridade Command Palette ↔ Sidebar para funções operacionais.

## Engenharia
- [ ] Testes unitários e integração reais.
- [ ] CI com gates de qualidade.
- [ ] Changelog e documentação atualizados.

---

## 12) Métricas de sucesso

- Redução de erros de autenticação/rede sem diagnóstico.
- Tempo para disparar e acompanhar deploy menor.
- Aumento de cobertura de testes e redução de regressões.
- Menos incidentes de segurança relacionados a token/transporte/UI.
- Adoção de funcionalidades além do “deploy básico”.

---

## 13) Decisão recomendada agora

Ordem de implementação recomendada:

1. Segurança (HTTPS + Webview hardening).
2. Robustez de API e testes.
3. Funcionalidades mais usadas do CLI (logs/deploy cancel/lifecycle app).
4. Multi-contexto e env vars.

---

## 14) Regra de implementação contínua (Sidebar First)

Para as próximas entregas, aplicar esta regra em todo PR:

1. Implementar a funcionalidade no serviço/comando.
2. Expor ação correspondente no sidebar (botão/toggle/menu no card/seção relevante).
3. Garantir feedback visual no sidebar (loading/sucesso/erro/estado vazio).
4. Garantir consistência com filtros/idioma/favoritos quando aplicável.

**Definition of Done adicional**
- Sem “feature órfã” apenas em comando: se houver comando novo de operação, deve existir caminho equivalente no sidebar.

Essa sequência maximiza segurança e valor para usuário sem inflar complexidade cedo demais.
