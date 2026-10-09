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

## Endpoints

| Método e rota | Quem | Sucesso | Erros principais |
|---|---|---|---|
| `POST /scripts` | criador | 201, versão 1 em `in_review` | 400 sem ator, 403 ator errado, 422 sem `campaign_id` ou sem texto |
| `GET /scripts/:id` | qualquer um | 200 com estado, versões, pedidos e `allowed_actions` | 404 |
| `POST /scripts/:id/change-requests` | marca | 200, vai para `changes_requested` | 422 sem motivo, sem prazo ou com prazo vencido; 409 fora de `in_review` |
| `POST /scripts/:id/versions` | criador | 200, versão N+1 em `in_review` | 422 sem texto; 409 fora de `changes_requested` ou depois de aprovado |
| `POST /scripts/:id/approve` | marca | 200, `approved` com `approved_version` | 409 com pedido aberto ou já aprovado; 403 se o criador tentar |

O fluxo inteiro em quatro chamadas:

```bash
curl -s -X POST localhost:3003/scripts -H "X-Actor: creator" -H "content-type: application/json" -d "{\"campaign_id\":\"cmp_77\",\"content\":\"Abertura: unboxing do fone em 15s.\"}"
curl -s -X POST localhost:3003/scripts/scr_1/change-requests -H "X-Actor: brand" -H "content-type: application/json" -d "{\"reason\":\"Citar o cupom CONTY10 nos primeiros 5 segundos.\",\"deadline\":\"2026-10-12\"}"
curl -s -X POST localhost:3003/scripts/scr_1/versions -H "X-Actor: creator" -H "content-type: application/json" -d "{\"content\":\"Abertura: unboxing do fone; cupom CONTY10 aos 3s.\"}"
curl -s -X POST localhost:3003/scripts/scr_1/approve -H "X-Actor: brand"
```

Os request e response completos de cada passo, inclusive os erros 422, 409 e 403, estão em [EXEMPLOS.md](EXEMPLOS.md). Foram gerados com `npm start` e `curl`.

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
