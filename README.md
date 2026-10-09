# Revisão de roteiro

API para a marca revisar o roteiro do criador antes do vídeo: o criador envia, a marca pede alteração com motivo e prazo, o criador reenvia, a marca aprova. Sem vídeo, upload nem interface.

## Como rodar

Node 22+.

```bash
npm install
npm test           # vitest, relógio controlado, sem rede
npm run typecheck  # tsc --noEmit
npm start          # http://127.0.0.1:3003 (PORT muda a porta)
```

Os dados ficam em memória (`InMemoryScriptRepository`) e somem quando o processo para.

## Estrutura

- `src/script.ts`: domínio puro. Estados, transições, quem pode o quê, validação do pedido.
- `src/deadline.ts`: prazo como data civil em `America/Sao_Paulo`, só com `Intl.DateTimeFormat`.
- `src/app.ts`: camada HTTP (Hono). Lê o ator, chama o domínio, traduz erro em status.
- `src/repository.ts`, `src/clock.ts`: adaptadores (repositório em memória e relógio injetável).

## Máquina de estados

| Estado atual | Ação | Quem | Próximo estado |
|---|---|---|---|
| — | `POST /scripts` | criador | `in_review` (versão 1) |
| `in_review` | `POST /scripts/:id/change-requests` | marca | `changes_requested` |
| `in_review` | `POST /scripts/:id/approve` | marca | `approved` |
| `changes_requested` | `POST /scripts/:id/versions` | criador | `in_review` (versão N+1) |
| `approved` | nenhuma | — | — |

Qualquer outra combinação devolve **409** com o motivo (ex.: "a versão 1 ainda está em revisão pela marca"). O `GET /scripts/:id` devolve o estado, todas as versões, todos os pedidos e `allowed_actions` (ação, ator, método e caminho), então quem consome a API não precisa deduzir o próximo passo.

## Decisões e regras

- **Ator**: cabeçalho `X-Actor: creator` ou `X-Actor: brand`. Não há autenticação nem dono do roteiro: qualquer `brand` revisa qualquer roteiro. Sem cabeçalho válido → 400; ator errado para a ação → 403.
- **Prazo é uma data civil** (`"deadline": "2026-10-12"`), interpretada em `America/Sao_Paulo`. Vale até 23:59:59.999 desse dia em São Paulo; para 2026-10-12 isso é `2026-10-13T02:59:59.999Z`, devolvido em `deadline_ends_at`. Data com horário, outro formato ou dia inexistente (`2026-02-30`) → 422.
- **Fuso sem biblioteca**: o offset sai de `Intl.DateTimeFormat` no próprio instante, então o horário de verão histórico (-02:00, até 2019) é respeitado. Os testes cobrem o dia em que a meia-noite não existiu (2018-11-04) e o dia em que 23h se repetiu (2019-02-16).
- **Prazo vale no momento do pedido**: se o dia do prazo já terminou em São Paulo quando a marca pede, o pedido é rejeitado (422). Prazo para o próprio dia é aceito.
- **Reenvio depois do prazo é aceito** e a versão sai com `submitted_after_deadline: true`. Recusar travaria o roteiro: no estado `changes_requested` só o criador age. Assim a marca vê o atraso e decide se aprova ou pede outra alteração. Enquanto o pedido está aberto e vencido, o `GET` mostra `overdue: true`.
- **Motivo e prazo são obrigatórios**: falta de um ou dos dois → 422 com `fields` dizendo o que falta. Motivo só com espaços conta como vazio.
- **Um pedido aberto por vez**: com pedido aberto a marca não pede outro nem aprova (409); espera a nova versão.
- **Aprovar encerra**: aprova sempre a versão mais recente e grava `approved_version`. Depois disso nova versão, novo pedido e nova aprovação → 409.
- **Versões são só acréscimo**: a versão nova entra no fim da lista com `in_response_to` apontando o pedido que ela atende; as anteriores não mudam.

## Endpoints e exemplos

Exemplos reais, gerados com `npm start` e `curl` em 2026-10-09. O JSON foi só indentado; onde a resposta repete a anterior, o texto diz isso em vez de colar de novo.

### Criador envia o roteiro

```http
POST /scripts
X-Actor: creator
Content-Type: application/json

{"campaign_id":"cmp_77","content":"Abertura: unboxing do fone em 15s."}
```

```json
HTTP 201
{
  "id": "scr_1",
  "campaign_id": "cmp_77",
  "status": "in_review",
  "current_version": 1,
  "approved_at": null,
  "approved_version": null,
  "versions": [
    {
      "number": 1,
      "content": "Abertura: unboxing do fone em 15s.",
      "submitted_at": "2026-10-09T15:18:33.959Z",
      "in_response_to": null,
      "submitted_after_deadline": false
    }
  ],
  "change_requests": [],
  "allowed_actions": [
    { "action": "request_changes", "actor": "brand", "method": "POST", "path": "/scripts/scr_1/change-requests" },
    { "action": "approve", "actor": "brand", "method": "POST", "path": "/scripts/scr_1/approve" }
  ]
}
```

### Marca pede alteração sem prazo, e com prazo vencido

```http
POST /scripts/scr_1/change-requests
X-Actor: brand

{"reason":"Citar o cupom CONTY10 nos primeiros 5 segundos."}
```

```json
HTTP 422
{"error":"pedido de alteração inválido","fields":{"deadline":"prazo é obrigatório: data AAAA-MM-DD no fuso America/Sao_Paulo"}}
```

```http
POST /scripts/scr_1/change-requests
X-Actor: brand

{"reason":"Citar o cupom","deadline":"2026-10-01"}
```

```json
HTTP 422
{"error":"pedido de alteração inválido","fields":{"deadline":"prazo 2026-10-01 já passou em America/Sao_Paulo (valia até 2026-10-02T02:59:59.999Z)"}}
```

### Marca pede alteração

```http
POST /scripts/scr_1/change-requests
X-Actor: brand

{"reason":"Citar o cupom CONTY10 nos primeiros 5 segundos.","deadline":"2026-10-12"}
```

```json
HTTP 200
{
  "id": "scr_1",
  "campaign_id": "cmp_77",
  "status": "changes_requested",
  "current_version": 1,
  "approved_at": null,
  "approved_version": null,
  "versions": [
    {
      "number": 1,
      "content": "Abertura: unboxing do fone em 15s.",
      "submitted_at": "2026-10-09T15:18:33.959Z",
      "in_response_to": null,
      "submitted_after_deadline": false
    }
  ],
  "change_requests": [
    {
      "id": "chg_1",
      "version": 1,
      "reason": "Citar o cupom CONTY10 nos primeiros 5 segundos.",
      "deadline": "2026-10-12",
      "deadline_time_zone": "America/Sao_Paulo",
      "deadline_ends_at": "2026-10-13T02:59:59.999Z",
      "requested_at": "2026-10-09T15:18:34.120Z",
      "resolved_by_version": null,
      "overdue": false
    }
  ],
  "allowed_actions": [
    { "action": "submit_version", "actor": "creator", "method": "POST", "path": "/scripts/scr_1/versions" }
  ]
}
```

`GET /scripts/scr_1` nesse momento devolve exatamente o mesmo corpo.

### Criador reenvia

```http
POST /scripts/scr_1/versions
X-Actor: creator

{"content":"Abertura: unboxing do fone; cupom CONTY10 aos 3s."}
```

Resposta 200 com `status: "in_review"`, `current_version: 2`, as duas versões e o pedido `chg_1` com `resolved_by_version: 2` (igual ao `GET` abaixo, sem a aprovação).

### Marca aprova

```http
POST /scripts/scr_1/approve
X-Actor: brand
```

```json
HTTP 200
{
  "id": "scr_1",
  "campaign_id": "cmp_77",
  "status": "approved",
  "current_version": 2,
  "approved_at": "2026-10-09T15:18:34.288Z",
  "approved_version": 2,
  "versions": [
    {
      "number": 1,
      "content": "Abertura: unboxing do fone em 15s.",
      "submitted_at": "2026-10-09T15:18:33.959Z",
      "in_response_to": null,
      "submitted_after_deadline": false
    },
    {
      "number": 2,
      "content": "Abertura: unboxing do fone; cupom CONTY10 aos 3s.",
      "submitted_at": "2026-10-09T15:18:34.228Z",
      "in_response_to": "chg_1",
      "submitted_after_deadline": false
    }
  ],
  "change_requests": [
    {
      "id": "chg_1",
      "version": 1,
      "reason": "Citar o cupom CONTY10 nos primeiros 5 segundos.",
      "deadline": "2026-10-12",
      "deadline_time_zone": "America/Sao_Paulo",
      "deadline_ends_at": "2026-10-13T02:59:59.999Z",
      "requested_at": "2026-10-09T15:18:34.120Z",
      "resolved_by_version": 2,
      "overdue": false
    }
  ],
  "allowed_actions": []
}
```

### Depois de aprovado

```http
POST /scripts/scr_1/versions            X-Actor: creator   {"content":"v3"}
POST /scripts/scr_1/change-requests     X-Actor: brand     {"reason":"Trocar a trilha.","deadline":"2026-10-14"}
```

```json
HTTP 409
{"error":"roteiro já aprovado na versão 2; a aprovação encerra a revisão"}
```

```http
POST /scripts/scr_1/approve
X-Actor: creator
```

```json
HTTP 403
{"error":"só a marca pode executar approve"}
```

## Testes

`test/deadline.test.ts` cobre o cálculo do prazo: último instante (`02:59:59.999Z`), primeiro instante do dia seguinte (`03:00:00.000Z`), UTC já virado com São Paulo ainda no dia do prazo e o horário de verão histórico. `test/scripts.test.ts` cobre a API com `app.request` e um relógio de teste: fluxo inteiro com `allowed_actions` em cada passo, 422 sem motivo ou prazo, prazo no limite, reenvio atrasado, 409 depois da aprovação, histórico de versões, 403 e 404.

## O que ficou de fora e o que faria diferente com mais tempo

- **Autenticação de verdade**: hoje o papel vem de um cabeçalho em que se confia. Com mais tempo, o ator viria de um token e o roteiro teria dono (criador e marca da campanha).
- **Persistência**: só memória. O próximo passo seria `node:sqlite` com versões e pedidos em tabelas só de inserção.
- **Concorrência**: dentro de um processo, cada transição lê, valida e grava sem nenhum `await` no meio, então é atômica: se aprovação e pedido de alteração chegam juntos, um vence e o outro recebe 409 (há teste para isso). Com vários processos ou um banco de verdade isso não basta; eu usaria controle otimista, com `If-Match` e a versão atual na aprovação e no pedido de alteração.
- **Prazo vencido sem resposta**: o pedido só aparece como `overdue`; nada expira sozinho nem notifica ninguém. Uma regra de negócio (cancelar a campanha, avisar a marca) precisaria de decisão de produto.
- **Fuso fixo**: todas as marcas estão em `America/Sao_Paulo`. Com mais tempo o fuso seria um campo da marca, passado para `deadline.ts` em vez da constante `BRAND_TIME_ZONE`.
- **Aprovação parcial ou comentários por trecho** do roteiro não existem; o motivo é um texto livre.

## Uso de IA

Implementação, testes e README escritos com Claude Code (IA da Anthropic) a partir do enunciado. Coordenei o trabalho junto com a IA: pedi que cada entrega fosse revisada item a item contra as seções O que fazer, Entrega e Como avaliamos do enunciado, e acompanhei as correções que saíram dessa revisão. Nessa revisão, os agentes de auditoria acharam uma corrida entre aprovar e pedir alteração que podia apagar a aprovação; ela foi corrigida e ganhou teste. O que eu revisei: o foco foi o prazo: os testes do último instante do dia e do primeiro instante do dia seguinte em São Paulo, com o relógio controlado. Revisei as decisões que mudam o comportamento (ator no header, reenvio depois do prazo aceito e marcado, um pedido de alteração aberto por vez) e a correção da corrida entre aprovar e pedir alteração. Testes (35/35) e typecheck limpos.
