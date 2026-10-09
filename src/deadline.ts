// O prazo é uma data civil (AAAA-MM-DD) no fuso da marca. O último instante
// desse dia (23:59:59.999 em São Paulo) ainda vale.
export const BRAND_TIME_ZONE = "America/Sao_Paulo";

const DAY_MS = 24 * 60 * 60 * 1000;

const WALL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: BRAND_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type CivilDate = { year: number; month: number; day: number };
type WallClock = CivilDate & { hour: number; minute: number; second: number };

function wallClock(epochMs: number): WallClock {
  const parts: Record<string, number> = {};
  for (const part of WALL_CLOCK.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

// Diferença entre o relógio de parede em São Paulo e o UTC naquele instante.
// Muda com o horário de verão histórico (-02:00 em vários verões até 2019).
function offsetMs(epochMs: number): number {
  const w = wallClock(epochMs);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

function format(date: CivilDate): string {
  const pad = (n: number, size: number) => String(n).padStart(size, "0");
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function parseCivilDate(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function civilDateAt(instant: Date): string {
  return format(wallClock(instant.getTime()));
}

function isMidnightOf(epochMs: number, date: CivilDate): boolean {
  const w = wallClock(epochMs);
  return (
    w.year === date.year && w.month === date.month && w.day === date.day &&
    w.hour === 0 && w.minute === 0 && w.second === 0
  );
}

function startOfDay(date: CivilDate): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  const offsetBefore = offsetMs(naive - DAY_MS);
  const offsetAfter = offsetMs(naive + DAY_MS);
  const candidates = [naive - offsetBefore, naive - offsetAfter].filter((t) => isMidnightOf(t, date));
  if (candidates.length > 0) return Math.min(...candidates);
  // Meia-noite que não existiu (início do horário de verão, ex.: 2018-11-04):
  // o dia começa no instante da troca, que é a meia-noite pelo offset antigo.
  return naive - offsetBefore;
}

export function deadlineEndsAt(deadline: string): Date {
  const date = parseCivilDate(deadline);
  if (!date) throw new Error(`prazo inválido: ${deadline}`);
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const nextDay = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  return new Date(startOfDay(nextDay) - 1);
}

export function isPastDeadline(now: Date, deadline: string): boolean {
  return now.getTime() > deadlineEndsAt(deadline).getTime();
}
