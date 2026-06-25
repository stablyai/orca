/**
 * Resource Manager popover merge helper.
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

import type { MemorySnapshot, SessionMemory, WorktreeMemory } from '../../../../shared/types'
import { parsePtySessionId } from '../../../../shared/pty-session-id-format'
import { parsePaneKey as parseStablePaneKey } from '../../../../shared/stable-pane-id'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree-id'
import type {
  DaemonSession,
  MergeContext,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import { buildResourceSessionBindingIndex } from './resource-session-bindings'

// ─── Helpers ────────────────────────────────────────────────────────

function deriveRepoIdFromWorktreeId(worktreeId: string): string {
  return getRepoIdFromWorktreeId(worktreeId)
}

function deriveWorktreeNameFromWorktreeId(worktreeId: string): string {
  return getWorktreePathBasenameFromId(worktreeId) ?? worktreeId
}

function shortCwd(cwd: string): string {
  if (!cwd) {
    return ''
  }
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(sep) : cwd
}

function parsePaneKey(paneKey: string | null): { tabId: string; leafId: string } | null {
  if (!paneKey) {
    return null
  }
  const parsed = parseStablePaneKey(paneKey)
  return parsed ? { tabId: parsed.tabId, leafId: parsed.leafId } : null
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

// ─── Public merge function ─────────────────────────────────────────

export const UNATTRIBUTED_REPO_ID = '__unattributed__'
export const UNATTRIBUTED_REPO_NAME = 'Unattributed'

export function mergeSnapshotAndSessions(
  snapshot: MemorySnapshot | null,
  daemonSessions: readonly DaemonSession[],
  ctx: MergeContext
): UnifiedProjectGroup[] {
  const repos = new Map<string, UnifiedProjectGroup>()
  const seenSessionIds = new Set<string>()
  // Why: pre-build O(1) lookup indices once per merge. This includes live
  // ptyIdsByTabId plus deferred-reattach wake hints, so restored inactive
  // sessions do not appear as Resource Manager orphans before their pane mounts.
  const index = buildResourceSessionBindingIndex(ctx)
  const boundPtyIds = index.boundPtyIds

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
  ): UnifiedProjectGroup {
    const existing = repos.get(repoId)
    if (existing) {
      return existing
    }
    const next: UnifiedProjectGroup = {
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
    repo: UnifiedProjectGroup,
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
