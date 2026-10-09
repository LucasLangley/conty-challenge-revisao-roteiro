import { Hono, type Context } from "hono";
import type { Clock } from "./clock.ts";
import { BRAND_TIME_ZONE } from "./deadline.ts";
import type { ScriptRepository } from "./repository.ts";
import {
  ACTION_ACTOR,
  allowedActions,
  approve,
  createScript,
  isOverdue,
  requestChanges,
  submitVersion,
  type Action,
  type Actor,
  type DomainError,
  type Result,
  type Script,
} from "./script.ts";

const ACTION_PATH: Record<Action, string> = {
  submit_version: "versions",
  request_changes: "change-requests",
  approve: "approve",
};

const ERROR_STATUS = { validation: 422, conflict: 409, forbidden: 403 } as const;

function view(script: Script, now: Date) {
  return {
    id: script.id,
    campaign_id: script.campaignId,
    status: script.status,
    current_version: script.versions.length,
    approved_at: script.approvedAt,
    approved_version: script.approvedVersion,
    versions: script.versions.map((v) => ({
      number: v.number,
      content: v.content,
      submitted_at: v.submittedAt,
      in_response_to: v.inResponseTo,
      submitted_after_deadline: v.submittedAfterDeadline,
    })),
    change_requests: script.changeRequests.map((r) => ({
      id: r.id,
      version: r.version,
      reason: r.reason,
      deadline: r.deadline,
      deadline_time_zone: BRAND_TIME_ZONE,
      deadline_ends_at: r.deadlineEndsAt,
      requested_at: r.requestedAt,
      resolved_by_version: r.resolvedByVersion,
      overdue: isOverdue(r, now),
    })),
    allowed_actions: allowedActions(script).map((action) => ({
      action,
      actor: ACTION_ACTOR[action],
      method: "POST",
      path: `/scripts/${script.id}/${ACTION_PATH[action]}`,
    })),
  };
}

function readActor(c: Context): Actor | null {
  const actor = c.req.header("x-actor");
  return actor === "creator" || actor === "brand" ? actor : null;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function errorResponse(c: Context, error: DomainError) {
  const body = error.fields ? { error: error.message, fields: error.fields } : { error: error.message };
  return c.json(body, ERROR_STATUS[error.kind]);
}

const ACTOR_REQUIRED = { error: "cabeçalho X-Actor obrigatório: creator ou brand" };

export function createApp(deps: { repo: ScriptRepository; clock: Clock }) {
  const { repo, clock } = deps;
  const app = new Hono();

  // Carrega o roteiro, aplica a transição do domínio e grava o resultado.
  // O corpo é lido antes: entre carregar e gravar não há await, então duas
  // requisições simultâneas não partem do mesmo estado e a segunda recebe 409.
  async function transition(
    c: Context,
    run: (script: Script, actor: Actor, body: Record<string, unknown>, now: Date) => Result<Script>,
  ) {
    const actor = readActor(c);
    if (!actor) return c.json(ACTOR_REQUIRED, 400);
    const body = await readBody(c);
    const script = repo.find(c.req.param("id")!);
    if (!script) return c.json({ error: "roteiro não encontrado" }, 404);
    const now = clock.now();
    const result = run(script, actor, body, now);
    if (!result.ok) return errorResponse(c, result.error);
    repo.save(result.value);
    return c.json(view(result.value, now), 200);
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/scripts", async (c) => {
    const actor = readActor(c);
    if (!actor) return c.json(ACTOR_REQUIRED, 400);
    if (actor !== "creator") return c.json({ error: "só o criador pode enviar roteiro" }, 403);
    const body = await readBody(c);
    const now = clock.now();
    const result = createScript({ nextId: () => repo.nextScriptId(), campaignId: body.campaign_id, content: body.content }, now);
    if (!result.ok) return errorResponse(c, result.error);
    repo.save(result.value);
    return c.json(view(result.value, now), 201);
  });

  app.get("/scripts/:id", (c) => {
    const script = repo.find(c.req.param("id"));
    if (!script) return c.json({ error: "roteiro não encontrado" }, 404);
    return c.json(view(script, clock.now()));
  });

  app.post("/scripts/:id/change-requests", (c) =>
    transition(c, (script, actor, body, now) =>
      requestChanges(script, actor, { nextId: () => repo.nextChangeRequestId(), reason: body.reason, deadline: body.deadline }, now),
    ),
  );

  app.post("/scripts/:id/versions", (c) =>
    transition(c, (script, actor, body, now) => submitVersion(script, actor, { content: body.content }, now)),
  );

  app.post("/scripts/:id/approve", (c) => transition(c, (script, actor, _body, now) => approve(script, actor, now)));

  return app;
}
