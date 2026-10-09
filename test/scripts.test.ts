import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";
import { InMemoryScriptRepository } from "../src/repository.ts";

type App = ReturnType<typeof createApp>;
type Actor = "creator" | "brand";

type ScriptView = {
  id: string;
  status: string;
  current_version: number;
  approved_version: number | null;
  versions: Array<{ number: number; content: string; in_response_to: string | null; submitted_after_deadline: boolean }>;
  change_requests: Array<{
    id: string;
    version: number;
    reason: string;
    deadline: string;
    deadline_ends_at: string;
    resolved_by_version: number | null;
    overdue: boolean;
  }>;
  allowed_actions: Array<{ action: string; actor: string; method: string; path: string }>;
};

type ErrorBody = { error: string; fields?: Record<string, string> };

class TestClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

let clock: TestClock;
let app: App;

beforeEach(() => {
  // 10:00 de 2026-10-09 em São Paulo.
  clock = new TestClock(new Date("2026-10-09T13:00:00.000Z"));
  app = createApp({ repo: new InMemoryScriptRepository(), clock });
});

function post(path: string, actor: Actor | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actor) headers["x-actor"] = actor;
  return app.request(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function get(id: string): Promise<ScriptView> {
  const res = await app.request(`/scripts/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ScriptView;
}

async function submitScript(content = "Abertura: unboxing do fone em 15s."): Promise<string> {
  const res = await post("/scripts", "creator", { campaign_id: "cmp_77", content });
  expect(res.status).toBe(201);
  return ((await res.json()) as ScriptView).id;
}

function requestChanges(id: string, body: unknown) {
  return post(`/scripts/${id}/change-requests`, "brand", body);
}

const validRequest = { reason: "Citar o cupom CONTY10 nos primeiros 5 segundos.", deadline: "2026-10-12" };

function actionsOf(view: ScriptView): string[] {
  return view.allowed_actions.map((a) => `${a.actor}:${a.action}`);
}

describe("fluxo completo sem adivinhar o estado", () => {
  it("criador envia, marca pede alteração, criador reenvia, marca aprova", async () => {
    const id = await submitScript();
    let view = await get(id);
    expect(view.status).toBe("in_review");
    expect(view.current_version).toBe(1);
    expect(actionsOf(view)).toEqual(["brand:request_changes", "brand:approve"]);
    expect(view.allowed_actions[0]!.path).toBe(`/scripts/${id}/change-requests`);

    expect((await requestChanges(id, validRequest)).status).toBe(200);
    view = await get(id);
    expect(view.status).toBe("changes_requested");
    expect(view.change_requests).toHaveLength(1);
    expect(view.change_requests[0]).toMatchObject({
      id: "chg_1",
      version: 1,
      reason: validRequest.reason,
      deadline: "2026-10-12",
      deadline_ends_at: "2026-10-13T02:59:59.999Z",
      resolved_by_version: null,
      overdue: false,
    });
    expect(actionsOf(view)).toEqual(["creator:submit_version"]);

    const resubmit = await post(`/scripts/${id}/versions`, "creator", { content: "Abertura com cupom CONTY10." });
    expect(resubmit.status).toBe(200);
    view = await get(id);
    expect(view.status).toBe("in_review");
    expect(view.current_version).toBe(2);
    expect(view.versions[1]).toMatchObject({ number: 2, in_response_to: "chg_1", submitted_after_deadline: false });
    expect(view.change_requests[0]!.resolved_by_version).toBe(2);
    expect(actionsOf(view)).toEqual(["brand:request_changes", "brand:approve"]);

    expect((await post(`/scripts/${id}/approve`, "brand")).status).toBe(200);
    view = await get(id);
    expect(view.status).toBe("approved");
    expect(view.approved_version).toBe(2);
    expect(view.allowed_actions).toEqual([]);
  });

  it("guarda a versão antiga intacta quando chega uma nova", async () => {
    const id = await submitScript("Versão original.");
    await requestChanges(id, validRequest);
    await post(`/scripts/${id}/versions`, "creator", { content: "Versão corrigida." });
    const view = await get(id);
    expect(view.versions.map((v) => [v.number, v.content])).toEqual([
      [1, "Versão original."],
      [2, "Versão corrigida."],
    ]);
  });

  it("aceita vários ciclos de alteração e mantém o histórico de pedidos", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    await post(`/scripts/${id}/versions`, "creator", { content: "v2" });
    await requestChanges(id, { reason: "Trocar a trilha.", deadline: "2026-10-14" });
    await post(`/scripts/${id}/versions`, "creator", { content: "v3" });
    const view = await get(id);
    expect(view.versions).toHaveLength(3);
    expect(view.change_requests.map((r) => [r.id, r.version, r.resolved_by_version])).toEqual([
      ["chg_1", 1, 2],
      ["chg_2", 2, 3],
    ]);
  });
});

describe("pedido de alteração exige motivo e prazo", () => {
  it.each([
    ["sem motivo", { deadline: "2026-10-12" }, ["reason"]],
    ["motivo em branco", { reason: "   ", deadline: "2026-10-12" }, ["reason"]],
    ["sem prazo", { reason: "Trocar a trilha." }, ["deadline"]],
    ["sem nada", {}, ["reason", "deadline"]],
    ["prazo com horário", { reason: "Trocar a trilha.", deadline: "2026-10-12T23:59:00Z" }, ["deadline"]],
    ["prazo que não existe", { reason: "Trocar a trilha.", deadline: "2026-02-30" }, ["deadline"]],
  ])("%s → 422 com erro por campo", async (_label, body, fields) => {
    const id = await submitScript();
    const res = await requestChanges(id, body);
    expect(res.status).toBe(422);
    const error = (await res.json()) as ErrorBody;
    expect(error.error).toBe("pedido de alteração inválido");
    expect(Object.keys(error.fields ?? {}).sort()).toEqual([...fields].sort());
    expect((await get(id)).status).toBe("in_review");
  });

  it("explica o que falta", async () => {
    const id = await submitScript();
    const error = (await (await requestChanges(id, {})).json()) as ErrorBody;
    expect(error.fields?.reason).toMatch(/motivo é obrigatório/);
    expect(error.fields?.deadline).toMatch(/prazo é obrigatório.*AAAA-MM-DD.*America\/Sao_Paulo/);
  });
});

describe("prazo no fuso da marca, com relógio controlado", () => {
  it("vale no último instante do dia: 23:59:59.999 em São Paulo (02:59:59.999Z do dia seguinte)", async () => {
    const id = await submitScript();
    clock.set("2026-10-13T02:59:59.999Z");
    const res = await requestChanges(id, validRequest);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScriptView).change_requests[0]!.overdue).toBe(false);
  });

  it("não vale no primeiro instante do dia seguinte: 00:00 em São Paulo (03:00:00.000Z)", async () => {
    const id = await submitScript();
    clock.set("2026-10-13T03:00:00.000Z");
    const res = await requestChanges(id, validRequest);
    expect(res.status).toBe(422);
    const error = (await res.json()) as ErrorBody;
    expect(error.fields?.deadline).toBe(
      "prazo 2026-10-12 já passou em America/Sao_Paulo (valia até 2026-10-13T02:59:59.999Z)",
    );
    expect((await get(id)).change_requests).toEqual([]);
  });

  it("não vira o dia errado quando o UTC já virou: 22:30 em São Paulo é 01:30Z do dia seguinte", async () => {
    const id = await submitScript();
    clock.set("2026-10-13T01:30:00.000Z");
    expect((await requestChanges(id, validRequest)).status).toBe(200);
  });

  it("prazo para o próprio dia é aceito", async () => {
    const id = await submitScript();
    expect((await requestChanges(id, { ...validRequest, deadline: "2026-10-09" })).status).toBe(200);
  });

  it("GET mostra o pedido como vencido a partir do primeiro instante do dia seguinte", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    clock.set("2026-10-13T02:59:59.999Z");
    expect((await get(id)).change_requests[0]!.overdue).toBe(false);
    clock.set("2026-10-13T03:00:00.000Z");
    const view = await get(id);
    expect(view.change_requests[0]!.overdue).toBe(true);
    expect(actionsOf(view)).toEqual(["creator:submit_version"]);
  });

  it("reenvio no último instante do prazo entra no prazo", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    clock.set("2026-10-13T02:59:59.999Z");
    await post(`/scripts/${id}/versions`, "creator", { content: "v2" });
    expect((await get(id)).versions[1]!.submitted_after_deadline).toBe(false);
  });

  it("reenvio depois do prazo é aceito e marcado como atrasado", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    clock.set("2026-10-13T03:00:00.000Z");
    const res = await post(`/scripts/${id}/versions`, "creator", { content: "v2" });
    expect(res.status).toBe(200);
    const view = await get(id);
    expect(view.status).toBe("in_review");
    expect(view.versions[1]!.submitted_after_deadline).toBe(true);
    expect(view.change_requests[0]).toMatchObject({ resolved_by_version: 2, overdue: false });
  });
});

describe("aprovação encerra a revisão", () => {
  async function approved(): Promise<string> {
    const id = await submitScript();
    expect((await post(`/scripts/${id}/approve`, "brand")).status).toBe(200);
    return id;
  }

  it("não aceita nova versão (409)", async () => {
    const id = await approved();
    const res = await post(`/scripts/${id}/versions`, "creator", { content: "v2" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toMatch(/já aprovado na versão 1/);
    expect((await get(id)).versions).toHaveLength(1);
  });

  it("não aceita novo pedido de alteração (409)", async () => {
    const id = await approved();
    const res = await requestChanges(id, validRequest);
    expect(res.status).toBe(409);
    const view = await get(id);
    expect(view.status).toBe("approved");
    expect(view.change_requests).toEqual([]);
  });

  it("não aprova de novo (409)", async () => {
    const id = await approved();
    expect((await post(`/scripts/${id}/approve`, "brand")).status).toBe(409);
  });

  // Duas requisições ao mesmo tempo não podem ler o mesmo estado e as duas gravarem.
  it.each([
    ["aprovação chega primeiro", "approve"],
    ["pedido de alteração chega primeiro", "change-request"],
  ] as const)("aprovação e pedido de alteração em paralelo: só um vence (%s)", async (_label, first) => {
    const id = await submitScript();
    const approveReq = () => post(`/scripts/${id}/approve`, "brand");
    const changeReq = () => requestChanges(id, validRequest);
    const [a, b] = await Promise.all(first === "approve" ? [approveReq(), changeReq()] : [changeReq(), approveReq()]);
    const [approveRes, changeRes] = first === "approve" ? [a, b] : [b, a];

    expect([approveRes.status, changeRes.status].sort()).toEqual([200, 409]);
    const view = await get(id);
    if (approveRes.status === 200) {
      expect(view.status).toBe("approved");
      expect(view.change_requests).toEqual([]);
      expect((await requestChanges(id, validRequest)).status).toBe(409);
      expect((await get(id)).status).toBe("approved");
    } else {
      expect(view.status).toBe("changes_requested");
      expect(view.approved_version).toBeNull();
    }
  });
});

describe("transições fora de ordem e atores", () => {
  it("criador não envia nova versão enquanto a atual está em revisão (409)", async () => {
    const id = await submitScript();
    const res = await post(`/scripts/${id}/versions`, "creator", { content: "v2" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toMatch(/versão 1 ainda está em revisão/);
  });

  it("marca não pede outra alteração nem aprova com pedido aberto (409)", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    expect((await requestChanges(id, { reason: "Outra coisa.", deadline: "2026-10-15" })).status).toBe(409);
    const res = await post(`/scripts/${id}/approve`, "brand");
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toMatch(/pedido de alteração aberto \(chg_1\)/);
  });

  it("cada ação tem seu ator (403)", async () => {
    expect((await post("/scripts", "brand", { campaign_id: "cmp_77", content: "x" })).status).toBe(403);
    const id = await submitScript();
    expect((await post(`/scripts/${id}/approve`, "creator")).status).toBe(403);
    expect((await post(`/scripts/${id}/change-requests`, "creator", validRequest)).status).toBe(403);
    await requestChanges(id, validRequest);
    expect((await post(`/scripts/${id}/versions`, "brand", { content: "v2" })).status).toBe(403);
  });

  it("sem X-Actor → 400; roteiro inexistente → 404", async () => {
    expect((await post("/scripts", null, { campaign_id: "cmp_77", content: "x" })).status).toBe(400);
    expect((await app.request("/scripts/scr_999")).status).toBe(404);
    expect((await post("/scripts/scr_999/approve", "brand")).status).toBe(404);
  });

  it("roteiro sem texto ou sem campanha → 422", async () => {
    const res = await post("/scripts", "creator", { content: "  " });
    expect(res.status).toBe(422);
    expect(Object.keys(((await res.json()) as ErrorBody).fields ?? {}).sort()).toEqual(["campaign_id", "content"]);
  });

  it("nova versão sem texto → 422 e o pedido continua aberto", async () => {
    const id = await submitScript();
    await requestChanges(id, validRequest);
    expect((await post(`/scripts/${id}/versions`, "creator", { content: "" })).status).toBe(422);
    const view = await get(id);
    expect(view.status).toBe("changes_requested");
    expect(view.versions).toHaveLength(1);
  });
});
