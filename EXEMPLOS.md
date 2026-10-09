# Exemplos de request e response

Fluxo completo da API de revisão de roteiro, do envio à aprovação. Volte para o [README](README.md).

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
