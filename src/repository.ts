import type { Script } from "./script.ts";

export interface ScriptRepository {
  find(id: string): Script | undefined;
  save(script: Script): void;
  nextScriptId(): string;
  nextChangeRequestId(): string;
}

export class InMemoryScriptRepository implements ScriptRepository {
  private readonly scripts = new Map<string, Script>();
  private scriptSeq = 0;
  private changeRequestSeq = 0;

  find(id: string): Script | undefined {
    const script = this.scripts.get(id);
    return script ? structuredClone(script) : undefined;
  }

  save(script: Script): void {
    this.scripts.set(script.id, structuredClone(script));
  }

  nextScriptId(): string {
    return `scr_${++this.scriptSeq}`;
  }

  nextChangeRequestId(): string {
    return `chg_${++this.changeRequestSeq}`;
  }
}
