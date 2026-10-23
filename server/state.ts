import { LABEL } from "../shared/labels";

interface SidekickState {
  sidekickId: string;
  leadId: string;
  profileId: string;
  briefId: string;
  createdAt: number;
  lastUsedAt: number;
  status: "idle" | "running" | "completed" | "failed";
  turnCount: number;
  totalCost: number;
}

interface DelegationState {
  leadId: string;
  sidekickId: string | null;
  briefId: string;
  brief: {
    goal: string;
    constraints?: string;
    success_criteria?: string;
    files_hint?: string[];
  };
  status: "dispatched" | "running" | "completed" | "blocked" | "failed" | "timeout";
  dispatchedAt: number;
  completedAt?: number;
  timeoutAt?: number;
}

/**
 * In-memory fusion state. Lost on reload or daemon restart.
 * For crash recovery, this should persist to a workspace-local JSON file.
 */
export class FusionState {
  private readonly sidekicks = new Map<string, SidekickState>();
  private readonly delegations = new Map<string, DelegationState>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Register a sidekick for reuse across briefs. */
  registerSidekick(state: SidekickState): void {
    this.sidekicks.set(state.sidekickId, state);
  }

  /** Find an existing sidekick for a lead and profile that is idle. */
  findReusableSidekick(leadId: string, profileId: string): SidekickState | null {
    for (const [id, state] of this.sidekicks) {
      if (
        state.leadId === leadId &&
        state.profileId === profileId &&
        state.status === "idle" &&
        this.now() - state.lastUsedAt < 24 * 60 * 60 * 1000 // Reuse within 24h
      ) {
        return state;
      }
    }
    return null;
  }

  /** Mark a sidekick as running. */
  setSidekickRunning(sidekickId: string): void {
    const state = this.sidekicks.get(sidekickId);
    if (state) {
      state.status = "running";
      state.lastUsedAt = this.now();
    }
  }

  /** Mark a sidekick as idle (available for reuse). */
  setSidekickIdle(sidekickId: string): void {
    const state = this.sidekicks.get(sidekickId);
    if (state) {
      state.status = "idle";
      state.lastUsedAt = this.now();
    }
  }

  /** Mark a sidekick as failed (should not be reused). */
  setSidekickFailed(sidekickId: string): void {
    const state = this.sidekicks.get(sidekickId);
    if (state) {
      state.status = "failed";
    }
  }

  /** Increment sidekick turn count. */
  incrementSidekickTurns(sidekickId: string): void {
    const state = this.sidekicks.get(sidekickId);
    if (state) {
      state.turnCount++;
    }
  }

  /** Add cost to sidekick. */
  addSidekickCost(sidekickId: string, cost: number): void {
    const state = this.sidekicks.get(sidekickId);
    if (state) {
      state.totalCost += cost;
    }
  }

  /** Check if sidekick has exceeded max turns. */
  hasExceededMaxTurns(sidekickId: string, maxTurns: number): boolean {
    const state = this.sidekicks.get(sidekickId);
    return state ? state.turnCount >= maxTurns : false;
  }

  /** Check if sidekick has exceeded max cost. */
  hasExceededMaxCost(sidekickId: string, maxCost: number): boolean {
    const state = this.sidekicks.get(sidekickId);
    return state ? state.totalCost >= maxCost : false;
  }

  /** Record a new delegation. */
  recordDelegation(delegation: DelegationState): void {
    this.delegations.set(delegation.briefId, delegation);
  }

  /** Update delegation status. */
  updateDelegationStatus(briefId: string, status: DelegationState["status"]): void {
    const delegation = this.delegations.get(briefId);
    if (delegation) {
      delegation.status = status;
      if (status === "completed" || status === "failed" || status === "timeout") {
        delegation.completedAt = this.now();
      }
    }
  }

  /** Set a timeout for a delegation. */
  setDelegationTimeout(briefId: string, timeoutMs: number, callback: () => void): void {
    const delegation = this.delegations.get(briefId);
    if (delegation) {
      delegation.timeoutAt = this.now() + timeoutMs;
      const timer = setTimeout(() => {
        this.clearDelegationTimeout(briefId);
        callback();
      }, timeoutMs);
      this.timeoutTimers.set(briefId, timer);
    }
  }

  /** Clear a delegation timeout. */
  clearDelegationTimeout(briefId: string): void {
    const timer = this.timeoutTimers.get(briefId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(briefId);
    }
  }

  /** Get delegation by brief ID. */
  getDelegation(briefId: string): DelegationState | null {
    return this.delegations.get(briefId) ?? null;
  }

  /** Get delegation by lead agent ID (for reconciliation on crash). */
  getDelegationByLead(leadId: string): DelegationState | null {
    let latest: DelegationState | null = null;
    for (const delegation of this.delegations.values()) {
      if (delegation.leadId === leadId && (!latest || delegation.dispatchedAt > latest.dispatchedAt)) {
        latest = delegation;
      }
    }
    return latest;
  }

  /** Get sidekick state. */
  getSidekick(sidekickId: string): SidekickState | null {
    return this.sidekicks.get(sidekickId) ?? null;
  }

  /** Clean up old delegations (older than 7 days). */
  cleanupOldDelegations(): void {
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [briefId, delegation] of this.delegations) {
      if (delegation.completedAt && delegation.completedAt < cutoff) {
        this.clearDelegationTimeout(briefId);
        this.delegations.delete(briefId);
      }
    }
  }

  /** Clean up old idle sidekicks (older than 7 days). */
  cleanupOldSidekicks(): void {
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [sidekickId, state] of this.sidekicks) {
      if (state.status === "idle" && state.lastUsedAt < cutoff) {
        this.sidekicks.delete(sidekickId);
      }
    }
  }

  /** Clear all state (called on settings change). */
  clear(): void {
    // Clear all timeout timers
    for (const [briefId, timer] of this.timeoutTimers) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();
    this.sidekicks.clear();
    this.delegations.clear();
  }
}
