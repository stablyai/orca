/* eslint-disable max-lines -- Why: this module deliberately co-locates the
   renderer-local view-model types, the merge function, and its supporting
   string-manipulation helpers because they exist solely to feed the popover
   in ResourceUsageStatusSegment.tsx. Splitting would scatter logic that has
   exactly one consumer. See docs/resource-usage-merge-spec.md. */
/**
 * Resource Usage popover merge helper.
 *
 * Produces a single grouped list (repo → worktree → session) by unifying:
 *
 *   - `MemorySnapshot.worktrees` — local PTYs only, with numeric CPU/Mem
 *     per worktree and per session (the local memory collector doesn't see
 *     SSH process trees, by design — see src/main/memory/collector.ts and
 *     the registerPty branch at src/main/ipc/pty.ts:832).
 *   - `pty.listSessions()` — every PTY the daemon tracks, local or SSH.
 *
 * The merge is renderer-only and pure. It does NOT widen the shared
 * `WorktreeMemory` shape; instead it emits a renderer-local view-model
 * with `Metric = number | null`, where `null` means "no local sample"
 * (e.g. an SSH session). The popover renders `null` cells as `—`.
 *
 * See docs/resource-usage-merge-spec.md for the full design.
 */

import type {
  MemorySnapshot,
  SessionMemory,
  TerminalTab,
  WorktreeMemory
} from '../../../../shared/types'
import { parsePtySessionId, WORKTREE_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'

// ─── View-model types (renderer-local) ──────────────────────────────

/** `null` === "no local sample" (e.g. SSH PTY); UI renders as em-dash. */
export type Metric = number | null

export type DaemonSession = {
  id: string
  cwd: string
  title: string
}

export type UnifiedSessionRow = {
  sessionId: string
  paneKey: string | null
  pid: number
  label: string
  bound: boolean
  tabId: string | null
  cpu: Metric
  memory: Metric
  hasLocalSamples: boolean
}

export type UnifiedWorktreeRow = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  history: number[]
  hasLocalSamples: boolean
  /** Why: the chip in ResourceUsageStatusSegment now keys on this — the repo
   *  has an SSH connectionId — instead of `!hasLocalSamples`, which used to
   *  mislabel warm-reattached *local* PTYs as REMOTE. */
  isRemote: boolean
  sessions: UnifiedSessionRow[]
}

export type UnifiedRepoGroup = {
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  /** Why: renamed in spirit but kept as `hasRemoteChildren` for callsite
   *  stability — the repo-level chip predicate is now "the repo's
   *  connectionId is non-null", which is the only way a repo can have
   *  remote children. */
  hasRemoteChildren: boolean
  worktrees: UnifiedWorktreeRow[]
}

// ─── Inputs that the renderer already has on hand ───────────────────

export type MergeContext = {
  /** From useAppStore: maps tabId → worktreeId for tab-walk resolution. */
  tabsByWorktree: Record<string, TerminalTab[]>
  /** From useAppStore: maps tabId → ptyIds[] for the bound check. */
  ptyIdsByTabId: Record<string, string[]>
  /** From useAppStore: per-tab live pane titles (for label resolution). */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** From useAppStore: false until the renderer has booted enough state to
   *  trust the bound/orphan distinction. Mirrors the existing gate. */
  workspaceSessionReady: boolean
  /** Repo display names by repo id. Used for new groups synthesized from
   *  daemon sessions whose repo isn't in the snapshot (typical SSH case). */
  repoDisplayNameById: Map<string, string>
  /** Repo connectionId by repo id (null/missing == local). Drives the
   *  `· remote` chip predicate, decoupling label from data-coverage. */
  repoConnectionIdById: Map<string, string | null>
}

// ─── Helpers ────────────────────────────────────────────────────────

function deriveRepoIdFromWorktreeId(worktreeId: string): string {
  const sep = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return sep > 0 ? worktreeId.slice(0, sep) : worktreeId
}

function deriveWorktreeNameFromWorktreeId(worktreeId: string): string {
  const sep = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (sep <= 0) {
    return worktreeId
  }
  const path = worktreeId.slice(sep + WORKTREE_ID_SEPARATOR.length)
  if (!path) {
    return worktreeId
  }
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? worktreeId
}

function shortCwd(cwd: string): string {
  if (!cwd) {
    return ''
  }
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(sep) : cwd
}

function parsePaneKey(paneKey: string | null): { tabId: string; paneRuntimeId: number } | null {
  if (!paneKey) {
    return null
  }
  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0) {
    return null
  }
  const paneRuntimeId = Number(paneKey.slice(sepIdx + 1))
  if (!Number.isFinite(paneRuntimeId)) {
    return null
  }
  return { tabId: paneKey.slice(0, sepIdx), paneRuntimeId }
}

function resolveSnapshotSessionLabel(
  session: SessionMemory,
  worktreeId: string,
  ctx: MergeContext
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const tabs = ctx.tabsByWorktree[worktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === parsed.tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtime = ctx.runtimePaneTitlesByTabId[parsed.tabId]?.[parsed.paneRuntimeId]?.trim()
      if (runtime) {
        return runtime
      }
      return tab.defaultTitle?.trim() || tab.title?.trim() || `Terminal ${tabIndex + 1}`
    }
  }
  if (session.pid > 0) {
    return `pid ${session.pid}`
  }
  const fallback = session.sessionId?.slice(0, 8)
  return fallback ? `session ${fallback}` : '(unknown session)'
}

function resolveDaemonSessionLabel(
  session: DaemonSession,
  resolvedWorktreeId: string | null,
  tabId: string | null,
  ctx: MergeContext
): string {
  if (tabId && resolvedWorktreeId) {
    const tabs = ctx.tabsByWorktree[resolvedWorktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtimeMap = ctx.runtimePaneTitlesByTabId[tabId]
      if (runtimeMap) {
        const live = Object.values(runtimeMap).find((t) => t?.trim())
        if (live) {
          return live
        }
      }
      const fallback = tab.defaultTitle?.trim() || tab.title?.trim()
      if (fallback) {
        return fallback
      }
    }
  }
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  if (resolvedWorktreeId) {
    return shortCwd(resolvedWorktreeId)
  }
  if (session.title) {
    return session.title
  }
  return 'unknown'
}

// Why: the previous implementation did O(N) linear scans over
// ptyIdsByTabId / tabsByWorktree for *every* session it processed. With a
// large workspace that's S * (T + W) work per merge — and the merge runs on
// every snapshot poll plus every store mutation. Pre-build O(1) lookup
// indices once per merge instead.
type MergeIndex = {
  ptyIdToTabId: Map<string, string>
  tabIdToWorktreeId: Map<string, string>
}

function buildMergeIndex(ctx: MergeContext): MergeIndex {
  const ptyIdToTabId = new Map<string, string>()
  for (const [tabId, ptyIds] of Object.entries(ctx.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      if (ptyId) {
        ptyIdToTabId.set(ptyId, tabId)
      }
    }
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(ctx.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  return { ptyIdToTabId, tabIdToWorktreeId }
}

// ─── Public merge function ─────────────────────────────────────────

export const UNATTRIBUTED_REPO_ID = '__unattributed__'
export const UNATTRIBUTED_REPO_NAME = 'Unattributed'

export function mergeSnapshotAndSessions(
  snapshot: MemorySnapshot | null,
  daemonSessions: readonly DaemonSession[],
  ctx: MergeContext
): UnifiedRepoGroup[] {
  const repos = new Map<string, UnifiedRepoGroup>()
  const seenSessionIds = new Set<string>()
  const index = buildMergeIndex(ctx)
  // Why: bound = the daemon session id appears as a pty id under some tab.
  // ptyIdToTabId already encodes that membership in O(1), so the bound set
  // is just its keys.
  const boundPtyIds = ctx.workspaceSessionReady
    ? new Set(index.ptyIdToTabId.keys())
    : new Set<string>()

  function isRepoRemote(repoId: string): boolean {
    // Why: missing entry === we don't know about this repo (typically the
    // unattributed bucket or a session whose repo metadata never made it
    // into the renderer). Treat unknown as not-remote so a missing-data
    // edge case can never spuriously flip the chip on. The chip should
    // only fire when we have positive evidence the repo is SSH-backed.
    return ctx.repoConnectionIdById.get(repoId) != null
  }

  function ensureRepo(
    repoId: string,
    repoName: string,
    initiallyHasRemoteChildren = false
  ): UnifiedRepoGroup {
    const existing = repos.get(repoId)
    if (existing) {
      return existing
    }
    const next: UnifiedRepoGroup = {
      repoId,
      repoName,
      cpu: null,
      memory: null,
      hasRemoteChildren: initiallyHasRemoteChildren || isRepoRemote(repoId),
      worktrees: []
    }
    repos.set(repoId, next)
    return next
  }

  function findWorktreeRow(
    repo: UnifiedRepoGroup,
    worktreeId: string
  ): UnifiedWorktreeRow | undefined {
    return repo.worktrees.find((w) => w.worktreeId === worktreeId)
  }

  // ── Step 1: ingest snapshot worktrees as the local-truth foundation.
  if (snapshot) {
    for (const wt of snapshot.worktrees as readonly WorktreeMemory[]) {
      const repo = ensureRepo(wt.repoId, wt.repoName)
      const sessions: UnifiedSessionRow[] = wt.sessions.map((s) => {
        seenSessionIds.add(s.sessionId)
        const tabId = index.ptyIdToTabId.get(s.sessionId) ?? null
        return {
          sessionId: s.sessionId,
          paneKey: s.paneKey,
          pid: s.pid,
          label: resolveSnapshotSessionLabel(s, wt.worktreeId, ctx),
          bound: ctx.workspaceSessionReady && boundPtyIds.has(s.sessionId),
          tabId,
          cpu: s.cpu,
          memory: s.memory,
          hasLocalSamples: true
        }
      })
      repo.worktrees.push({
        worktreeId: wt.worktreeId,
        worktreeName: wt.worktreeName,
        repoId: wt.repoId,
        repoName: wt.repoName,
        cpu: wt.cpu,
        memory: wt.memory,
        history: wt.history,
        hasLocalSamples: true,
        isRemote: isRepoRemote(wt.repoId),
        sessions
      })
    }
  }

  // ── Step 2: union daemon sessions that the snapshot didn't cover.
  for (const session of daemonSessions) {
    if (seenSessionIds.has(session.id)) {
      continue
    }
    seenSessionIds.add(session.id)

    // 2a: tab-store walk — does this session belong to a tab in this renderer?
    const tabId = index.ptyIdToTabId.get(session.id) ?? null
    let worktreeId = tabId ? (index.tabIdToWorktreeId.get(tabId) ?? null) : null

    // 2b: @@-parse — recover worktreeId from the minted session id format.
    if (!worktreeId) {
      worktreeId = parsePtySessionId(session.id).worktreeId
    }

    // 2c: unattributed bucket.
    const isUnattributed = !worktreeId
    const finalWorktreeId = worktreeId ?? `${UNATTRIBUTED_REPO_ID}::${session.id}`
    const finalRepoId = isUnattributed
      ? UNATTRIBUTED_REPO_ID
      : deriveRepoIdFromWorktreeId(finalWorktreeId)
    const finalRepoName = isUnattributed
      ? UNATTRIBUTED_REPO_NAME
      : ctx.repoDisplayNameById.get(finalRepoId) || finalRepoId
    const finalWorktreeName = isUnattributed
      ? session.title || session.id.slice(0, 12)
      : deriveWorktreeNameFromWorktreeId(finalWorktreeId)

    const repoIsRemote = isRepoRemote(finalRepoId)
    const repo = ensureRepo(finalRepoId, finalRepoName, repoIsRemote)
    if (repoIsRemote) {
      repo.hasRemoteChildren = true
    }

    let row = findWorktreeRow(repo, finalWorktreeId)
    if (!row) {
      row = {
        worktreeId: finalWorktreeId,
        worktreeName: finalWorktreeName,
        repoId: finalRepoId,
        repoName: finalRepoName,
        cpu: null,
        memory: null,
        history: [],
        hasLocalSamples: false,
        isRemote: repoIsRemote,
        sessions: []
      }
      repo.worktrees.push(row)
    }

    row.sessions.push({
      sessionId: session.id,
      paneKey: null,
      pid: 0,
      label: resolveDaemonSessionLabel(session, worktreeId, tabId, ctx),
      bound: ctx.workspaceSessionReady && boundPtyIds.has(session.id),
      tabId,
      cpu: null,
      memory: null,
      hasLocalSamples: false
    })
  }

  // ── Step 3: per-repo aggregates. Remote children are identified by the
  //   repo's connectionId, not by missing data — `!hasLocalSamples` would
  //   mislabel warm-reattached local PTYs. The aggregate still skips rows
  //   we can't sample (worktree.cpu === null) so the numbers stay honest.
  for (const repo of repos.values()) {
    let cpuSum = 0
    let memSum = 0
    let anyLocal = false
    for (const wt of repo.worktrees) {
      if (wt.cpu !== null && wt.memory !== null) {
        cpuSum += wt.cpu
        memSum += wt.memory
        anyLocal = true
      }
    }
    repo.cpu = anyLocal ? cpuSum : null
    repo.memory = anyLocal ? memSum : null
  }

  return [...repos.values()]
}
