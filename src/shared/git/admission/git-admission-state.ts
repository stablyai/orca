import * as os from 'node:os'
import type { GitAdmissionTier } from '../../rpc-contract/git-admission-tier-params'

// Older relay hosts lack availableParallelism; keep their concurrency conservative.
const parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 1
export const GENERAL_CAP = Math.max(2, Math.min(4, parallelism - 4))
export const NETWORK_CAP = 3
export const CHECKOUT_CAP = 2
export const GENERAL_HEADROOM = 2
export const NETWORK_HEADROOM = 1
export const CHECKOUT_HEADROOM = 1
export const ROUTE_CAP = 2
export const ROUTE_HEADROOM = 1
export const GIT_ADMISSION_AGING_MS = 15_000
// General 4+2, network 3+1 and checkout 2+1 admit at most thirteen Git roots per runtime;
// worktree deletes bypass admission under their own limit (WORKTREE_DELETE_CONCURRENCY).
export const MAX_GIT_CHILDREN = 13

export type AdmissionClass = 'general' | 'network' | 'checkout'
export type AdmissionSlotKind = 'base' | 'headroom'

export type GitAdmissionRequest = {
  args: readonly string[]
  cwd: string
  wslDistro?: string
  tier?: GitAdmissionTier
  admissionClass?: 'checkout'
  signal?: AbortSignal
}

export type GitAdmissionGrant = {
  queueWaitMs: number
  release: () => void
}

export type AdmissionBudgetSnapshot = {
  key: string
  baseCapacity: number
  headroomCapacity: number
  baseUsed: number
  headroomUsed: number
}

export type GitAdmissionEvent = {
  sequence: number
  phase: 'grant' | 'release'
  waiterId: number
  args: readonly string[]
  tier: GitAdmissionTier
  admissionClass: AdmissionClass
  route: string | null
  slotKind: AdmissionSlotKind
  queueWaitMs: number
  queued: number
  budgets: AdmissionBudgetSnapshot[]
}

export type AdmissionSchedulerConfig = {
  generalCap: number
  networkCap: number
  checkoutCap: number
  generalHeadroom: number
  networkHeadroom: number
  checkoutHeadroom: number
  routeCap: number
  routeHeadroom: number
  agingMs: number
  now: () => number
  onAdmissionEvent?: (event: GitAdmissionEvent) => void
}

export const DEFAULT_ADMISSION_SCHEDULER_CONFIG: AdmissionSchedulerConfig = {
  generalCap: GENERAL_CAP,
  networkCap: NETWORK_CAP,
  checkoutCap: CHECKOUT_CAP,
  generalHeadroom: GENERAL_HEADROOM,
  networkHeadroom: NETWORK_HEADROOM,
  checkoutHeadroom: CHECKOUT_HEADROOM,
  routeCap: ROUTE_CAP,
  routeHeadroom: ROUTE_HEADROOM,
  agingMs: GIT_ADMISSION_AGING_MS,
  now: () => performance.now()
}

export type AdmissionBudget = {
  baseCapacity: number
  headroomCapacity: number
  baseUsed: number
  headroomUsed: number
}

export type AdmissionWaiter = {
  id: number
  args: readonly string[]
  tier: GitAdmissionTier
  admissionClass: AdmissionClass
  route: string | null
  enqueuedAt: number
  budgetKeys: readonly string[]
  signal?: AbortSignal
  state: 'queued' | 'granted' | 'settled'
  slotKind?: AdmissionSlotKind
  resolve: (grant: GitAdmissionGrant) => void
  reject: (error: Error) => void
  onAbort: () => void
}

type AdmissionEventDetails = {
  waiter: AdmissionWaiter
  slotKind: AdmissionSlotKind
  phase: GitAdmissionEvent['phase']
  queueWaitMs: number
  queued: number
  budgets: ReadonlyMap<string, AdmissionBudget>
}

export class AdmissionEventPublisher {
  private nextSequence = 0

  constructor(private readonly listener?: (event: GitAdmissionEvent) => void) {}

  publish(details: AdmissionEventDetails): void {
    if (!this.listener) {
      return
    }
    const event: GitAdmissionEvent = {
      sequence: this.nextSequence++,
      phase: details.phase,
      waiterId: details.waiter.id,
      args: details.waiter.args,
      tier: details.waiter.tier,
      admissionClass: details.waiter.admissionClass,
      route: details.waiter.route,
      slotKind: details.slotKind,
      queueWaitMs: details.queueWaitMs,
      queued: details.queued,
      budgets: [...details.budgets].map(([key, budget]) => ({ key, ...budget }))
    }
    try {
      this.listener(event)
    } catch {
      // Measurement must never affect admission.
    }
  }
}

export const ADMISSION_TIER_VALUE: Record<GitAdmissionTier, number> = {
  interactive: 0,
  status: 1,
  background: 2
}
