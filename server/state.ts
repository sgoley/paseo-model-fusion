import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { BriefSchema, ReportSchema, DelegationStatusSchema, isActive, type Report, type DelegationView } from "../shared/models";

const SidekickSchema = z.object({
  sidekickId: z.string(), leadId: z.string(), workspaceId: z.string(), profileId: z.string(),
  profileSignature: z.string(), briefId: z.string(), createdAt: z.number(), lastUsedAt: z.number(),
  status: z.enum(["idle", "running", "failed"]), turnCount: z.number(), totalCost: z.number(),
  turnId: z.string().nullable().default(null),
});
const DelegationSchema = z.object({
  briefId: z.string(), reportToken: z.string(), leadId: z.string(), workspaceId: z.string(),
  profileId: z.string(), sidekickModel: z.string(), sidekickId: z.string().nullable(),
  leadTurnId: z.string().nullable(), brief: BriefSchema, status: DelegationStatusSchema,
  dispatchedAt: z.number(), timeoutAt: z.number(), completedAt: z.number().nullable().default(null),
  report: ReportSchema.nullable().default(null), reportDeliveredAt: z.number().nullable().default(null),
  error: z.string().nullable().default(null), stopConfirmed: z.boolean().default(false),
  costLead: z.number().nullable().default(null), costSidekick: z.number().nullable().default(null),
});
const SnapshotSchema = z.object({
  version: z.literal(1), sidekicks: z.array(SidekickSchema), delegations: z.array(DelegationSchema),
  usageTurns: z.array(z.object({ key: z.string(), at: z.number() })),
});
export type SidekickState = z.output<typeof SidekickSchema>;
export type DelegationState = z.output<typeof DelegationSchema>;
type NewDelegation = z.input<typeof DelegationSchema>;

export class FusionState {
  private readonly sidekicks = new Map<string, SidekickState>();
  private readonly delegations = new Map<string, DelegationState>();
  private readonly usageTurns = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  readonly filePath: string | undefined;

  constructor(options: { filePath?: string; now?: () => number } = {}) {
    this.now = options.now || Date.now;
    this.filePath = options.filePath;
    if (!this.filePath || !existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    let snapshot: z.output<typeof SnapshotSchema>;
    try {
      const json = JSON.parse(raw);
      if (json.version !== 1) throw new Error("Unsupported Fusion state version; refusing to overwrite it");
      snapshot = SnapshotSchema.parse(json);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unsupported")) throw error;
      const backup = this.filePath + ".corrupt-" + this.now();
      renameSync(this.filePath, backup);
      console.error("[fusion] Invalid state preserved at " + backup, error);
      return;
    }
    for (const item of snapshot.sidekicks) this.sidekicks.set(item.sidekickId, item);
    for (const item of snapshot.delegations) this.delegations.set(item.briefId, item);
    for (const item of snapshot.usageTurns) this.usageTurns.set(item.key, item.at);
  }

  flush(): void {
    if (!this.filePath) return;
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = this.filePath + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify({
      version: 1, sidekicks: [...this.sidekicks.values()], delegations: [...this.delegations.values()],
      usageTurns: [...this.usageTurns].map(([key, at]) => ({ key, at })),
    }), { mode: 0o600 });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.filePath);
    const directory = openSync(dir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  recordDelegation(input: NewDelegation): DelegationState {
    const item = DelegationSchema.parse(input);
    this.delegations.set(item.briefId, item);
    this.flush();
    return item;
  }
  updateDelegation(id: string, patch: Partial<DelegationState>): DelegationState {
    const current = this.delegations.get(id);
    if (!current) throw new Error("Delegation not found");
    Object.assign(current, patch);
    if (!isActive(current.status) && current.completedAt === null) current.completedAt = this.now();
    this.flush();
    return current;
  }
  getDelegation(id: string) { return this.delegations.get(id) ?? null; }
  getDelegations() { return [...this.delegations.values()]; }
  getDelegationByLead(id: string) { return this.newest((item) => item.leadId === id); }
  getDelegationBySidekick(id: string) {
    const sidekick = this.sidekicks.get(id);
    return sidekick ? this.getDelegation(sidekick.briefId) : this.newest((item) => item.sidekickId === id);
  }
  private newest(predicate: (item: DelegationState) => boolean): DelegationState | null {
    return [...this.delegations.values()].reverse().find(predicate) ?? null;
  }
  hasDelegationForTurn(leadId: string, turnId: string) {
    return [...this.delegations.values()].some((item) => item.leadId === leadId && item.leadTurnId === turnId);
  }
  registerSidekick(item: SidekickState): void { this.sidekicks.set(item.sidekickId, SidekickSchema.parse(item)); this.flush(); }
  getSidekick(id: string) { return this.sidekicks.get(id) ?? null; }
  getSidekicks() { return [...this.sidekicks.values()]; }
  updateSidekick(id: string, patch: Partial<SidekickState>): void {
    const current = this.sidekicks.get(id);
    if (current) { Object.assign(current, patch); this.flush(); }
  }
  findReusableSidekick(leadId: string, signature: string, maxTurns: number, maxCost: number): SidekickState | null {
    return [...this.sidekicks.values()].find((item) =>
      item.leadId === leadId && item.profileSignature === signature && item.status === "idle" &&
      item.turnCount < maxTurns && item.totalCost < maxCost &&
      this.now() - item.lastUsedAt < 86_400_000,
    ) ?? null;
  }
  acceptReport(id: string, token: string, report: Report): DelegationState | null {
    const item = this.getDelegation(id);
    if (!item || token !== item.reportToken) return null;
    if (item.report) return JSON.stringify(item.report) === JSON.stringify(report) ? item : null;
    if (!isActive(item.status)) return null;
    this.clearTimer(id);
    return this.updateDelegation(id, {
      report, status: report.status === "blocked" || report.status === "needs-clarification" ? "blocked" : "completed",
    });
  }
  recordUsage(agentId: string, turnId: string, cost: number | null, role: "lead" | "sidekick"): boolean {
    const key = agentId + ":" + turnId;
    if (this.usageTurns.has(key)) return false;
    this.usageTurns.set(key, this.now());
    const validCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
    if (role === "sidekick") {
      const sidekick = this.sidekicks.get(agentId);
      if (sidekick) {
        sidekick.turnCount++;
        if (validCost !== null) sidekick.totalCost += validCost;
      }
      const delegation = this.getDelegationBySidekick(agentId);
      if (delegation && validCost !== null) delegation.costSidekick = (delegation.costSidekick ?? 0) + validCost;
    } else if (validCost !== null) {
      let targets = this.getDelegations().filter((item) => item.leadId === agentId && item.leadTurnId === turnId);
      if (!targets.length) {
        const latest = this.getDelegationByLead(agentId);
        if (latest) targets = [latest];
      }
      for (const item of targets) item.costLead = (item.costLead ?? 0) + validCost / targets.length;
    }
    this.flush();
    return true;
  }
  armTimer(id: string, callback: () => void | Promise<void>): void {
    this.clearTimer(id);
    const item = this.getDelegation(id);
    if (!item || !isActive(item.status)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void Promise.resolve().then(callback).catch((error) => console.error("[fusion] Timeout failed", error));
    }, Math.max(0, Math.min(2_147_483_647, item.timeoutAt - this.now())));
    timer.unref?.();
    this.timers.set(id, timer);
  }
  clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  view(item: DelegationState): DelegationView {
    return {
      id: item.briefId, workspaceId: item.workspaceId, leadId: item.leadId,
      sidekickId: item.sidekickId, profileId: item.profileId, sidekickModel: item.sidekickModel,
      brief: item.brief, status: item.status, dispatchedAt: item.dispatchedAt,
      completedAt: item.completedAt, timeoutAt: item.timeoutAt, report: item.report,
      reportDelivered: item.reportDeliveredAt !== null, error: item.error,
      costLead: item.costLead, costSidekick: item.costSidekick,
    };
  }
  workspace(input: { workspaceId: string; offset: number; limit: number; search: string; activeOnly: boolean }) {
    const all = this.getDelegations().filter((item) => item.workspaceId === input.workspaceId);
    const search = input.search.trim().toLocaleLowerCase();
    const filtered = all.filter((item) => (!input.activeOnly || isActive(item.status)) &&
      (!search || [item.brief.goal, item.report?.summary, item.sidekickModel, item.profileId].some((value) => value?.toLocaleLowerCase().includes(search))))
      .sort((a, b) => b.dispatchedAt - a.dispatchedAt);
    return {
      delegations: filtered.slice(input.offset, input.offset + input.limit).map((item) => this.view(item)),
      total: filtered.length, active: all.filter((item) => isActive(item.status)).length,
      costLead: all.reduce((sum, item) => sum + (item.costLead ?? 0), 0),
      costSidekick: all.reduce((sum, item) => sum + (item.costSidekick ?? 0), 0),
      missingCost: all.some((item) => item.costLead === null || item.costSidekick === null),
    };
  }
  prune(days: number): void {
    const cutoff = this.now() - days * 86_400_000;
    for (const [id, item] of this.delegations) {
      if (item.completedAt !== null && item.completedAt < cutoff && (!item.report || item.reportDeliveredAt !== null)) {
        this.clearTimer(id); this.delegations.delete(id);
      }
    }
    for (const [id, item] of this.sidekicks) if (item.status !== "running" && item.lastUsedAt < cutoff) this.sidekicks.delete(id);
    for (const [key, at] of this.usageTurns) if (at < cutoff) this.usageTurns.delete(key);
    this.flush();
  }
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.flush();
  }
}
