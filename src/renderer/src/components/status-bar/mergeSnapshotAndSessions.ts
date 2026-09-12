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

import type {
  MemorySnapshot,
  SessionMemory,
  WorktreeMemory
} from '../../../../shared/process-stats-types'
import { parsePtySessionId } from '../../../../shared/pty-session-id-format'
import { parsePaneKey as parseStablePaneKey } from '../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree/id'
import type {
  DaemonSession,
  MergeContext,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingIndex
} from './resource-session-bindings'
import { resolveResourceWorkspaceHost } from './resource-workspace-host'

// ─── Helpers ────────────────────────────────────────────────────────

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
  index: ResourceSessionBindingIndex
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const match = index.tabsByIdByWorktree.get(worktreeId)?.get(parsed.tabId)
    const tab = match?.tab
    const tabIndex = match?.index ?? -1
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
  ctx: MergeContext,
  index: ResourceSessionBindingIndex
): string {
  if (tabId && resolvedWorktreeId) {
    const tab = index.tabsByIdByWorktree.get(resolvedWorktreeId)?.get(tabId)?.tab
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
  const worktreeRowsByRepo = new Map<string, Map<string, UnifiedWorktreeRow>>()
  const seenSessionIds = new Set<string>()
  // Why: pre-build O(1) lookup indices once per merge. This includes live
  // ptyIdsByTabId plus deferred-reattach wake hints, so restored inactive
  // sessions do not appear as Resource Manager orphans before their pane mounts.
  const index = buildResourceSessionBindingIndex(ctx)
  const boundPtyIds = index.boundPtyIds
  // Why: the daemon list is the only place agent ownership is reported. Snapshot-derived rows
  // describe the same sessions by id, so carry it across rather than inventing an answer; a
  // session the daemon never listed is 'unknown', not 'absent'.
  const ownershipBySessionId = new Map(
    daemonSessions.map((session) => [session.id, session.agentOwnership])
  )

  function ensureRepo(repoId: string, repoName: string): UnifiedProjectGroup {
    const existing = repos.get(repoId)
    if (existing) {
      return existing
    }
    const next: UnifiedProjectGroup = {
      repoId,
      repoName,
      cpu: null,
      memory: null,
      hasRemoteChildren: false,
      worktrees: []
    }
    repos.set(repoId, next)
    worktreeRowsByRepo.set(repoId, new Map())
    return next
  }

  function findWorktreeRow(
    repo: UnifiedProjectGroup,
    worktreeId: string
  ): UnifiedWorktreeRow | undefined {
    return worktreeRowsByRepo.get(repo.repoId)?.get(worktreeId)
  }

  function appendWorktreeRow(repo: UnifiedProjectGroup, row: UnifiedWorktreeRow): void {
    repo.worktrees.push(row)
    repo.hasRemoteChildren ||= row.isRemote
    const rows = worktreeRowsByRepo.get(repo.repoId)!
    if (!rows.has(row.worktreeId)) {
      rows.set(row.worktreeId, row)
    }
  }

  // ── Step 1: ingest snapshot worktrees as the local-truth foundation.
  if (snapshot) {
    for (const wt of snapshot.worktrees as readonly WorktreeMemory[]) {
      const worktree =
        parseWorkspaceKey(wt.worktreeId)?.type === 'folder'
          ? ctx.worktreeById?.get(wt.worktreeId)
          : undefined
      const repoId = worktree?.repoId ?? wt.repoId
      const repoName = (worktree && ctx.repoDisplayNameById.get(repoId)) || wt.repoName
      const { isRemote, isRuntimeScoped } = resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId)
      // Why: local snapshot data must never render under a runtime-hosted repo
      // row; belt-and-braces with the matching session-ingest guard below.
      if (isRuntimeScoped) {
        continue
      }
      const repo = ensureRepo(repoId, repoName)
      const sessions: UnifiedSessionRow[] = wt.sessions.map((s) => {
        seenSessionIds.add(s.sessionId)
        const tabId = index.ptyIdToTabId.get(s.sessionId) ?? null
        return {
          sessionId: s.sessionId,
          paneKey: s.paneKey,
          pid: s.pid,
          label: resolveSnapshotSessionLabel(s, wt.worktreeId, index),
          bound: ctx.workspaceSessionReady && boundPtyIds.has(s.sessionId),
          agentOwnership: ownershipBySessionId.get(s.sessionId) ?? 'unknown',
          tabId,
          cpu: s.cpu,
          memory: s.memory,
          hasLocalSamples: true
        }
      })
      appendWorktreeRow(repo, {
        worktreeId: wt.worktreeId,
        worktreeName: worktree?.displayName?.trim() || wt.worktreeName,
        repoId,
        repoName,
        cpu: wt.cpu,
        memory: wt.memory,
        history: wt.history,
        hasLocalSamples: true,
        isRemote,
        sessions,
        browsers: []
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

    // Prefer daemon metadata; older publishers may only encode the workspace in the session id.
    if (!worktreeId) {
      worktreeId = session.worktreeId || parsePtySessionId(session.id).worktreeId
    }

    // 2c: unattributed bucket.
    const isUnattributed = !worktreeId
    const finalWorktreeId = worktreeId ?? `${UNATTRIBUTED_REPO_ID}::${session.id}`
    const worktree =
      parseWorkspaceKey(finalWorktreeId)?.type === 'folder'
        ? ctx.worktreeById?.get(finalWorktreeId)
        : undefined
    const finalRepoId = isUnattributed
      ? UNATTRIBUTED_REPO_ID
      : (worktree?.repoId ?? getRepoIdFromWorktreeId(finalWorktreeId))
    const finalRepoName = isUnattributed
      ? UNATTRIBUTED_REPO_NAME
      : ctx.repoDisplayNameById.get(finalRepoId) || finalRepoId
    const finalWorktreeName = isUnattributed
      ? session.title || session.id.slice(0, 12)
      : worktree?.displayName?.trim() || deriveWorktreeNameFromWorktreeId(finalWorktreeId)

    // Why: the current daemon inputs are local/SSH only; this guard prevents a
    // future local daemon row accidentally exposing kill actions for runtime PTYs.
    const { isRemote, isRuntimeScoped } = resolveResourceWorkspaceHost(
      ctx,
      finalWorktreeId,
      finalRepoId
    )
    if (isRuntimeScoped) {
      continue
    }

    const repo = ensureRepo(finalRepoId, finalRepoName)

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
        isRemote,
        sessions: [],
        browsers: []
      }
      appendWorktreeRow(repo, row)
    }

    row.sessions.push({
      sessionId: session.id,
      paneKey: null,
      pid: 0,
      label: resolveDaemonSessionLabel(session, worktreeId, tabId, ctx, index),
      bound: ctx.workspaceSessionReady && boundPtyIds.has(session.id),
      agentOwnership: session.agentOwnership,
      tabId,
      cpu: null,
      memory: null,
      hasLocalSamples: false
    })
  }

  // ── Step 3: add browser resources, including browser-only workspaces.
  for (const [worktreeId, browsers] of Object.entries(ctx.browserTabsByWorktree ?? {})) {
    const worktree = ctx.worktreeById?.get(worktreeId)
    if (!worktree || browsers.length === 0) {
      continue
    }
    const repoName = ctx.repoDisplayNameById.get(worktree.repoId) || worktree.repoId
    const repo = ensureRepo(worktree.repoId, repoName)
    let row = findWorktreeRow(repo, worktreeId)
    if (!row) {
      row = {
        worktreeId,
        worktreeName: worktree.displayName,
        repoId: worktree.repoId,
        repoName,
        cpu: null,
        memory: null,
        history: [],
        hasLocalSamples: false,
        isRemote: resolveResourceWorkspaceHost(ctx, worktreeId, worktree.repoId).isRemote,
        sessions: [],
        browsers: []
      }
      appendWorktreeRow(repo, row)
    }
    row.browsers = browsers
  }

  // Only sampled rows contribute to project totals.
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
