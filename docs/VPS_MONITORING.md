# Monitoramento de VPS (Hostinger)

O Coolify enxerga o que acontece **dentro** dos containers. Ele não sabe se a
máquina ficou sem memória, se o disco encheu ou se a rede saturou. Este módulo
cobre essa camada usando a API da Hostinger e liga cada VPS aos recursos do
Coolify que rodam nela.

A pergunta que ele responde: *"as 7 aplicações caíram por bug ou porque a
máquina ficou sem disco?"*

## Índice

- [Habilitar](#habilitar)
- [Correlação com o Coolify](#correlação-com-o-coolify)
- [Alertas](#alertas)
- [Operações irreversíveis](#operações-irreversíveis)
- [Segurança do token](#segurança-do-token)
- [Quando o módulo está desligado](#quando-o-módulo-está-desligado)

## Habilitar

1. No painel da Hostinger, gere um token de API em **API / Developers**.
2. Defina no `.env` do Control Center:

```bash
HOSTINGER_API_TOKEN=seu_token_aqui
```

3. Suba o stack novamente. A aba **Infraestrutura** aparece no painel.

Endpoints consumidos (documentação: <https://developers.hostinger.com>):

| Finalidade | Rota |
|---|---|
| Inventário de máquinas | `GET /api/vps/v1/virtual-machines` |
| Detalhe da máquina | `GET /api/vps/v1/virtual-machines/{id}` |
| **Métricas** (CPU, RAM, disco, rede, uptime) | `GET /api/vps/v1/virtual-machines/{id}/metrics?date_from=&date_to=` |
| Operações assíncronas | `GET /api/vps/v1/virtual-machines/{id}/actions` |
| Snapshot | `GET/POST/DELETE .../snapshot` |
| Restaurar snapshot | `POST .../snapshot/restore` |
| Backups | `GET .../backups` |
| Restaurar backup | `POST .../backups/{backupId}/restore` |
| Energia | `POST .../start`, `.../stop`, `.../restart` |

## Correlação com o Coolify

A ligação é feita pelo **IP**: o campo `ip` do servidor no Coolify é comparado com
o IPv4 da máquina na Hostinger. É isso que transforma dois painéis separados em um
diagnóstico único.

Quando o IP não bate — NAT, IP flutuante, proxy na frente — dá para fixar o vínculo
manualmente na tabela `server_vm_link` (requer o histórico habilitado):

```sql
INSERT INTO server_vm_link (server_uuid, vm_id, link_source)
VALUES ('uuid-do-servidor-coolify', 'id-da-vm-hostinger', 'manual')
ON CONFLICT (server_uuid) DO UPDATE
  SET vm_id = EXCLUDED.vm_id, link_source = 'manual';
```

Vínculos manuais têm prioridade sobre a correlação automática por IP.

## Alertas

Limiares configuráveis por variável de ambiente:

```bash
ALERT_CPU_PCT=85
ALERT_RAM_PCT=90
ALERT_DISK_PCT=85
ALERT_CONSECUTIVE_SAMPLES=2
```

`ALERT_CONSECUTIVE_SAMPLES` é a **histerese**: a métrica precisa ficar acima do
limite por N coletas seguidas antes de alertar. Sem isso um pico de 3 segundos
faria a faixa de alerta piscar e o operador aprenderia a ignorá-la.

A coleta roda a cada 60s (`VPS_METRICS_POLL_MS`). Um `429` da Hostinger pausa as
chamadas até o `retry-after` informado — insistir só prolonga o bloqueio.

## Operações irreversíveis

O painel expõe cobertura total da API, incluindo restaurar snapshot e backup.
**Restaurar volta a máquina inteira no tempo: tudo gravado depois do ponto de
restauração é perdido e não há como recuperar.**

Toda operação de escrita passa por quatro travas:

1. **Raio de impacto** — o painel lista quantos recursos do Coolify rodam naquela
   máquina antes de liberar o botão. Reiniciar uma VPS não é reiniciar um
   container: leva tudo junto.
2. **Digitação do hostname** — não basta clicar; é preciso digitar o nome exato da
   máquina.
3. **Reconhecimento explícito de perda de dados** — só para restaurações, com a
   data do ponto de restauração em destaque.
4. **Auditoria antes e depois** — a intenção é gravada *antes* da chamada, então
   mesmo uma queda no meio da operação deixa registro de quem pediu o quê.

Nenhuma rota da Hostinger é exposta como ferramenta de IA. Reiniciar um container
é reversível; restaurar uma VPS não é, e isso está fora do que faz sentido deixar
um modelo de linguagem alcançar.

### Restauração pelo painel

1. Aba **Infraestrutura** → expandir **Snapshots e backups**.
2. Conferir a data do ponto de restauração.
3. Ler o raio de impacto.
4. Digitar o hostname e marcar o reconhecimento de perda de dados.
5. Confirmar.

Depois de restaurar, valide os recursos do Coolify naquele servidor: containers
podem precisar ser reiniciados para reconectar a volumes e redes.

## Segurança do token

`HOSTINGER_API_TOKEN` dá poder sobre a **conta Hostinger inteira**, incluindo
criar e destruir máquinas. Portanto:

- vive apenas no backend, nunca chega ao navegador;
- nunca aparece em resposta de erro (corpos da Hostinger ficam só no log do servidor);
- se vazar, revogue no painel da Hostinger **antes** de gerar outro.

## Quando o módulo está desligado

Sem `HOSTINGER_API_TOKEN` a aba Infraestrutura não aparece e `/api/vps` responde
`503` com mensagem explicativa. Todo o resto do Control Center funciona
normalmente — o monitoramento de VPS é um acréscimo, nunca uma dependência.

## Histórico das métricas

Com `HISTORY_DATABASE_URL` configurado, cada coleta é gravada em
`vps_metric_sample` e os gráficos passam a usar a série local (mais densa e sem
custo de API). Sem histórico, os gráficos consultam a Hostinger diretamente e
ficam limitados à granularidade que ela devolve.

Ver [MULTI_PROJECT_CONTROL_CENTER.md](MULTI_PROJECT_CONTROL_CENTER.md) para o
restante da arquitetura.
