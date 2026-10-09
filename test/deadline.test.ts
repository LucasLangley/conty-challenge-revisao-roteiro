import { describe, expect, it } from "vitest";
import { civilDateAt, deadlineEndsAt, isPastDeadline, parseCivilDate } from "../src/deadline.ts";

describe("prazo como data civil em America/Sao_Paulo", () => {
  it("termina às 23:59:59.999 de São Paulo, que é 02:59:59.999Z do dia seguinte", () => {
    expect(deadlineEndsAt("2026-10-12").toISOString()).toBe("2026-10-13T02:59:59.999Z");
  });

  it("vale no último instante do dia e não vale no primeiro instante do dia seguinte", () => {
    expect(isPastDeadline(new Date("2026-10-13T02:59:59.999Z"), "2026-10-12")).toBe(false);
    expect(isPastDeadline(new Date("2026-10-13T03:00:00.000Z"), "2026-10-12")).toBe(true);
  });

  it("não vira o dia quando o UTC já virou mas São Paulo ainda está no dia do prazo", () => {
    const lateEvening = new Date("2026-10-13T01:30:00.000Z");
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-10-13");
    expect(civilDateAt(lateEvening)).toBe("2026-10-12");
    expect(isPastDeadline(lateEvening, "2026-10-12")).toBe(false);
  });

  it("usa o offset de horário de verão histórico (-02:00)", () => {
    expect(deadlineEndsAt("2018-12-15").toISOString()).toBe("2018-12-16T01:59:59.999Z");
  });

  it("dia seguinte começa à 01:00 quando a meia-noite foi pulada (início do verão em 2018-11-04)", () => {
    expect(deadlineEndsAt("2018-11-03").toISOString()).toBe("2018-11-04T02:59:59.999Z");
    expect(deadlineEndsAt("2018-11-04").toISOString()).toBe("2018-11-05T01:59:59.999Z");
  });

  it("dia com a hora 23 repetida (fim do verão em 2019-02-16) termina na segunda passagem", () => {
    expect(deadlineEndsAt("2019-02-16").toISOString()).toBe("2019-02-17T02:59:59.999Z");
    expect(civilDateAt(new Date("2019-02-17T02:59:59.999Z"))).toBe("2019-02-16");
    expect(civilDateAt(new Date("2019-02-17T03:00:00.000Z"))).toBe("2019-02-17");
  });

  it("aceita só datas AAAA-MM-DD que existem no calendário", () => {
    expect(parseCivilDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseCivilDate("2026-02-30")).toBeNull();
    expect(parseCivilDate("2026-10-12T23:59:00-03:00")).toBeNull();
    expect(parseCivilDate("12/10/2026")).toBeNull();
  });
});
