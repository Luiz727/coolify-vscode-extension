# Taxonomia de status (regra de negócio)

Este documento é normativo. A extensão VS Code e o Control Center web **precisam**
concordar sobre o que cada status significa — quando divergiram, o mesmo recurso
aparecia verde no site e com problema no editor, e ninguém sabia em qual acreditar.

Implementações que devem permanecer equivalentes:

- [src/utils/resourceStatus.ts](../src/utils/resourceStatus.ts) — extensão
- [web-control-center/backend/status.js](../web-control-center/backend/status.js) — backend web
- [src/templates/webview.html](../src/templates/webview.html) — função `parseStatus` do sidebar

## Formato do status no Coolify

O Coolify devolve o status como `<container>:<saude>`, por exemplo `running:healthy`.
O sufixo de saúde é o resultado do healthcheck configurado no recurso. Nem todo
status traz o sufixo.

## Regra central

> **Um container no ar mas com healthcheck falhando NÃO está saudável.**
> `running:unhealthy` é **degradado**, nunca "rodando".

Essa é a regra que mais impacta a operação: um recurso nesse estado responde ao
Docker mas não responde ao usuário final. Tratá-lo como verde esconde exatamente
o tipo de incidente que mais demora a ser percebido.

## Tabela de classificação

| Status do container | Bucket | Significado operacional |
|---|---|---|
| `running` | `running` | No ar e saudável |
| `healthy` | `running` | No ar e saudável |
| `running:unhealthy` | **`degraded`** | No ar, mas o healthcheck falha |
| `degraded` | `degraded` | Parcialmente disponível |
| `starting` | `starting` | Subindo |
| `restarting` | `starting` | Reiniciando |
| `created` | `starting` | Criado, ainda não iniciado |
| `initializing` | `starting` | Inicializando |
| `exited` | `stopped` | Parado |
| `stopped` | `stopped` | Parado |
| `paused` | `stopped` | Pausado |
| `removing` | `stopped` | Sendo removido |
| `dead` | `error` | Morto |
| `error` / `failed` | `error` | Em erro |
| vazio / desconhecido | `unknown` | Não foi possível determinar |

Status livres que contenham `error`, `fail` ou `crash` caem em `error`.

## Armadilha da substring

`"unhealthy".includes("healthy")` é **verdadeiro**. Qualquer implementação precisa
testar o caso negativo primeiro:

```js
if (texto.includes('unhealthy')) return 'unhealthy';
if (texto.includes('healthy'))   return 'healthy';
```

A ordem inversa classificava recursos doentes como saudáveis. Há teste de regressão
em [src/test/resourceStatus.test.ts](../src/test/resourceStatus.test.ts) e em
[web-control-center/backend/test/status.test.js](../web-control-center/backend/test/status.test.js).

## Ordenação na interface

Problemas primeiro. Um painel de operação existe para mostrar o que está quebrado:

```
error → degraded → stopped → starting → unknown → running
```

## Contagem

Todo bucket precisa estar visível na interface, incluindo `unknown`. Se a soma dos
cartões não fecha com o total de recursos, existe um bucket escondido — e um
recurso invisível é pior que um recurso vermelho.

## Ao alterar esta tabela

1. Atualize as três implementações.
2. Atualize os testes nos dois lados.
3. Atualize esta tabela.

Divergência entre elas é considerada defeito, não detalhe de implementação.
