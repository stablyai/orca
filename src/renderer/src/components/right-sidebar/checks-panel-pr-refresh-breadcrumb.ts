import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { getGitHubPRRefreshStateExpiryAt, type PRRefreshState } from '@/store/slices/github'
import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../../../shared/crash-reporting'

type ChecksPanelPRRefreshBreadcrumbEvent = 'start' | 'done' | 'stale_cleared'
type ChecksPanelReviewProvider = 'github' | 'gitlab'

type ChecksPanelPRRefreshBreadcrumbArgs = {
  event: ChecksPanelPRRefreshBreadcrumbEvent
  provider: ChecksPanelReviewProvider
  repoId?: string | null
  worktreeId?: string | null
  branch?: string | null
  prCacheKey?: string | null
  prNumber?: number | null
  prState?: string | null
  prChecksStatus?: string | null
  refreshState?: PRRefreshState | null
  outcome?: string | null
  durationMs?: number | null
  currentRequest?: boolean
  now?: number
}

const BREADCRUMB_NAMES: Record<ChecksPanelPRRefreshBreadcrumbEvent, string> = {
  start: 'checks_panel_pr_refresh_start',
  done: 'checks_panel_pr_refresh_done',
  stale_cleared: 'checks_panel_pr_refresh_stale_cleared'
}

export function recordChecksPanelPRRefreshBreadcrumb(
  args: ChecksPanelPRRefreshBreadcrumbArgs
): void {
  recordRendererCrashBreadcrumb(
    BREADCRUMB_NAMES[args.event],
    buildChecksPanelPRRefreshBreadcrumbData(args)
  )
}

export function buildChecksPanelPRRefreshBreadcrumbData(
  args: ChecksPanelPRRefreshBreadcrumbArgs
): CrashReportBreadcrumbData {
  const now = args.now ?? Date.now()
  const refreshState = args.refreshState ?? null
  return compactBreadcrumbData({
    provider: args.provider,
    repoId: args.repoId,
    worktreeId: args.worktreeId,
    branchHash: args.branch ? hashString(args.branch) : undefined,
    branchLength: args.branch?.length,
    prCacheKeyHash: args.prCacheKey ? hashString(args.prCacheKey) : undefined,
    prNumber: args.prNumber,
    prState: args.prState,
    prChecksStatus: args.prChecksStatus,
    refreshStatus: refreshState?.status,
    refreshReason: refreshState?.reason,
    refreshAgeMs:
      refreshState && Number.isFinite(refreshState.updatedAt)
        ? Math.max(0, now - refreshState.updatedAt)
        : undefined,
    refreshExpiresInMs: getRefreshExpiresInMs(refreshState, now),
    outcome: args.outcome,
    durationMs: args.durationMs,
    currentRequest: args.currentRequest
  })
}

function getRefreshExpiresInMs(state: PRRefreshState | null, now: number): number | undefined {
  const expiryAt = getGitHubPRRefreshStateExpiryAt(state ?? undefined)
  return expiryAt === null ? undefined : Math.max(0, expiryAt - now)
}

function compactBreadcrumbData(
  data: Record<string, CrashReportDetailValue | undefined>
): CrashReportBreadcrumbData {
  const compacted: CrashReportBreadcrumbData = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      compacted[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      compacted[key] = value
    }
  }
  return compacted
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
