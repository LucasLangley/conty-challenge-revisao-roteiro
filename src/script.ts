import { BRAND_TIME_ZONE, deadlineEndsAt, parseCivilDate } from "./deadline.ts";

export type Actor = "creator" | "brand";
export type ScriptStatus = "in_review" | "changes_requested" | "approved";
export type Action = "submit_version" | "request_changes" | "approve";

export type Version = {
  number: number;
  content: string;
  submittedAt: string;
  inResponseTo: string | null;
  submittedAfterDeadline: boolean;
};

export type ChangeRequest = {
  id: string;
  version: number;
  reason: string;
  deadline: string;
  deadlineEndsAt: string;
  requestedAt: string;
  resolvedByVersion: number | null;
};

export type Script = {
  id: string;
  campaignId: string;
  status: ScriptStatus;
  versions: Version[];
  changeRequests: ChangeRequest[];
  approvedAt: string | null;
  approvedVersion: number | null;
};

export type DomainError = {
  kind: "validation" | "conflict" | "forbidden";
  message: string;
  fields?: Record<string, string>;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };

// Máquina de estados: cada estado lista as ações aceitas e para onde levam.
// "approved" não tem saída: a aprovação encerra a revisão e não reabre.
export const TRANSITIONS: Record<ScriptStatus, Partial<Record<Action, ScriptStatus>>> = {
  in_review: { request_changes: "changes_requested", approve: "approved" },
  changes_requested: { submit_version: "in_review" },
  approved: {},
};

export const ACTION_ACTOR: Record<Action, Actor> = {
  submit_version: "creator",
  request_changes: "brand",
  approve: "brand",
};

const ACTOR_LABEL: Record<Actor, string> = { creator: "o criador", brand: "a marca" };

export function allowedActions(script: Script): Action[] {
  return Object.keys(TRANSITIONS[script.status]) as Action[];
}

export function openChangeRequest(script: Script): ChangeRequest | null {
  return script.changeRequests.find((request) => request.resolvedByVersion === null) ?? null;
}

export function isOverdue(request: ChangeRequest, now: Date): boolean {
  return request.resolvedByVersion === null && now.getTime() > Date.parse(request.deadlineEndsAt);
}

function fail<T>(kind: DomainError["kind"], message: string, fields?: Record<string, string>): Result<T> {
  return { ok: false, error: fields ? { kind, message, fields } : { kind, message } };
}

function conflictMessage(script: Script, action: Action): string {
  if (script.status === "approved") {
    return `roteiro já aprovado na versão ${script.approvedVersion}; a aprovação encerra a revisão`;
  }
  if (script.status === "in_review") {
    return `a versão ${script.versions.length} ainda está em revisão pela marca; nova versão só depois de um pedido de alteração`;
  }
  const open = openChangeRequest(script);
  const verb = action === "approve" ? "aprovar" : "pedir outra alteração";
  return `há um pedido de alteração aberto (${open?.id}); para ${verb}, aguarde a nova versão do criador`;
}

function guard(script: Script, action: Action, actor: Actor): DomainError | null {
  const expected = ACTION_ACTOR[action];
  if (actor !== expected) {
    return { kind: "forbidden", message: `só ${ACTOR_LABEL[expected]} pode executar ${action}` };
  }
  if (!(action in TRANSITIONS[script.status])) {
    return { kind: "conflict", message: conflictMessage(script, action) };
  }
  return null;
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function createScript(
  input: { nextId: () => string; campaignId: unknown; content: unknown },
  now: Date,
): Result<Script> {
  const campaignId = requiredText(input.campaignId);
  const content = requiredText(input.content);
  const fields: Record<string, string> = {};
  if (!campaignId) fields.campaign_id = "campanha é obrigatória";
  if (!content) fields.content = "texto do roteiro é obrigatório";
  if (!campaignId || !content) return fail("validation", "roteiro inválido", fields);

  return {
    ok: true,
    value: {
      id: input.nextId(),
      campaignId,
      status: "in_review",
      versions: [{ number: 1, content, submittedAt: now.toISOString(), inResponseTo: null, submittedAfterDeadline: false }],
      changeRequests: [],
      approvedAt: null,
      approvedVersion: null,
    },
  };
}

export function requestChanges(
  script: Script,
  actor: Actor,
  input: { nextId: () => string; reason: unknown; deadline: unknown },
  now: Date,
): Result<Script> {
  const blocked = guard(script, "request_changes", actor);
  if (blocked) return { ok: false, error: blocked };

  const fields: Record<string, string> = {};
  const reason = requiredText(input.reason);
  if (!reason) fields.reason = "motivo é obrigatório: diga o que precisa mudar";

  const deadline = typeof input.deadline === "string" ? input.deadline.trim() : "";
  if (input.deadline === undefined || input.deadline === null || deadline === "") {
    fields.deadline = `prazo é obrigatório: data AAAA-MM-DD no fuso ${BRAND_TIME_ZONE}`;
  } else if (!parseCivilDate(deadline)) {
    fields.deadline = `prazo inválido: use uma data AAAA-MM-DD (dia no fuso ${BRAND_TIME_ZONE}), sem horário`;
  }
  if (Object.keys(fields).length > 0) return fail("validation", "pedido de alteração inválido", fields);

  // Pedido com prazo vencido não vale: o dia do prazo inteiro em São Paulo ainda conta.
  const endsAt = deadlineEndsAt(deadline);
  if (now.getTime() > endsAt.getTime()) {
    return fail("validation", "pedido de alteração inválido", {
      deadline: `prazo ${deadline} já passou em ${BRAND_TIME_ZONE} (valia até ${endsAt.toISOString()})`,
    });
  }

  const request: ChangeRequest = {
    id: input.nextId(),
    version: script.versions.length,
    reason: reason!,
    deadline,
    deadlineEndsAt: endsAt.toISOString(),
    requestedAt: now.toISOString(),
    resolvedByVersion: null,
  };
  return {
    ok: true,
    value: { ...script, status: "changes_requested", changeRequests: [...script.changeRequests, request] },
  };
}

export function submitVersion(script: Script, actor: Actor, input: { content: unknown }, now: Date): Result<Script> {
  const blocked = guard(script, "submit_version", actor);
  if (blocked) return { ok: false, error: blocked };

  const content = requiredText(input.content);
  if (!content) return fail("validation", "versão inválida", { content: "texto do roteiro é obrigatório" });

  const open = openChangeRequest(script)!;
  const number = script.versions.length + 1;
  // Reenvio depois do prazo é aceito, mas fica marcado para a marca decidir.
  const version: Version = {
    number,
    content,
    submittedAt: now.toISOString(),
    inResponseTo: open.id,
    submittedAfterDeadline: now.getTime() > Date.parse(open.deadlineEndsAt),
  };
  return {
    ok: true,
    value: {
      ...script,
      status: "in_review",
      versions: [...script.versions, version],
      changeRequests: script.changeRequests.map((r) => (r.id === open.id ? { ...r, resolvedByVersion: number } : r)),
    },
  };
}

export function approve(script: Script, actor: Actor, now: Date): Result<Script> {
  const blocked = guard(script, "approve", actor);
  if (blocked) return { ok: false, error: blocked };
  return {
    ok: true,
    value: { ...script, status: "approved", approvedAt: now.toISOString(), approvedVersion: script.versions.length },
  };
}
