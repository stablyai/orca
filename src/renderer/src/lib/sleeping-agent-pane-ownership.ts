import type { useAppStore } from '@/store'
import {
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export function getProviderSessionClaimKey(record: SleepingAgentSessionRecord): string {
  const base = `${record.worktreeId}\0${record.agent}\0${record.providerSession.key}\0${record.providerSession.id}`
  return record.agent === 'pi' || record.agent === 'prime-agent'
    ? `${base}\0${record.providerSession.transcriptPath ?? ''}`
    : base
}

export function isPassiveCompletedHibernationEvidence(record: SleepingAgentSessionRecord): boolean {
  return record.origin !== 'quit' && record.origin !== 'live' && record.state === 'done'
}

// Why: re-leafed adoption may only relaunch sessions that would legitimately
// auto-resume; completed/interrupted rows must neither relaunch nor block a
// live sibling's adoption by inflating the candidate count. Only quit/live
// recovery rows qualify — worktree-sleep and originless legacy captures keep
// the fork-a-new-tab wake path, which would otherwise race this adoption into
// a double resume of one provider session.
function isAdoptableRebuiltPaneRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    (record.origin === 'quit' || record.origin === 'live') &&
    record.state !== 'done' &&
    record.interrupted !== true &&
    isResumableTuiAgent(record.agent)
  )
}

/**
 * After a crash removed a tab's terminal layout, the rebuilt pane mounts a
 * fresh leaf UUID while sleeping records still point at the old one. Returns
 * the single record that pane may adopt by tab/worktree identity, or null when
 * candidates are absent or ambiguous (including any legacy-numeric-key record
 * on the tab, whose selection connectPanePty resolves separately).
 */
export function findUniqueAdoptableRebuiltPaneRecord(
  state: AppStoreState,
  worktreeId: string,
  tabId: string
): { paneKey: string; record: SleepingAgentSessionRecord } | null {
  const entries = Object.entries(state.sleepingAgentSessionsByPaneKey)
  const hasLegacyCandidate = entries.some(([paneKey, record]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return (
      legacy?.tabId === tabId &&
      record.worktreeId === worktreeId &&
      (!record.tabId || record.tabId === tabId)
    )
  })
  if (hasLegacyCandidate) {
    return null
  }
  const matches = entries.filter(([paneKey, record]) => {
    const parsed = parsePaneKey(paneKey)
    return (
      parsed?.tabId === tabId &&
      record.worktreeId === worktreeId &&
      (!record.tabId || record.tabId === tabId) &&
      isAdoptableRebuiltPaneRecord(record)
    )
  })
  if (matches.length === 0) {
    return null
  }
  // Why: any bound candidate means the identity is already owned by its own
  // pane — fail closed instead of resuming it a second time in another pane.
  if (
    matches.some(([paneKey]) => paneKeyLeafIsBoundInLayout(paneKey, state.terminalLayoutsByTabId))
  ) {
    return null
  }
  // Why: repeated crash/adopt cycles can leave several rows for one provider
  // session; they are a single recovery identity, so adopt the freshest row.
  // Distinct sessions remain ambiguous and fail closed.
  const claimKey = getProviderSessionClaimKey(matches[0][1])
  if (!matches.every(([, record]) => getProviderSessionClaimKey(record) === claimKey)) {
    return null
  }
  const [paneKey, record] = matches.reduce((best, candidate) =>
    candidate[1].updatedAt > best[1].updatedAt ? candidate : best
  )
  return { paneKey, record }
}

function getLegacyPaneTabId(record: SleepingAgentSessionRecord): string | null {
  const legacy = parseLegacyNumericPaneKey(record.paneKey)
  if (!legacy || (record.tabId && record.tabId !== legacy.tabId)) {
    return null
  }
  return record.tabId ?? legacy.tabId
}

function getLegacyProviderSessionKeysForTab(
  state: AppStoreState,
  worktreeId: string,
  tabId: string
): Set<string> {
  const keys = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record.worktreeId === worktreeId && getLegacyPaneTabId(record) === tabId) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  return Boolean(
    node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId))
  )
}

function hasMatchingStablePaneLayout(
  tabId: string,
  leafId: string,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  // Why: hibernation intentionally clears the live PTY binding after the pane
  // exits, but the preserved leaf still owns cold-restore for its session.
  return layoutContainsLeaf(terminalLayoutsByTabId[tabId]?.root, leafId)
}

/**
 * Whether a stable pane key's leaf is still bound in its tab's layout. A bound
 * leaf belongs to a pane that restores its own session directly, so adoption —
 * which exists only for leaves a crash lost — must fail closed on it.
 */
export function paneKeyLeafIsBoundInLayout(
  paneKey: string,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  const parsed = parsePaneKey(paneKey)
  return (
    parsed !== null &&
    hasMatchingStablePaneLayout(parsed.tabId, parsed.leafId, terminalLayoutsByTabId)
  )
}

function hasRestorableStablePanePty(
  tab: TerminalTab,
  tabId: string,
  leafId: string,
  ptyIdsByTabId: Record<string, string[] | undefined>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  const layout = terminalLayoutsByTabId[tabId]
  const hasLeafPty = Boolean(layout?.ptyIdsByLeafId?.[leafId])
  const isSingleLeafLayout = layout?.root?.type === 'leaf' && layout.root.leafId === leafId

  return Boolean(
    hasLeafPty || (isSingleLeafLayout && (tab.ptyId || (ptyIdsByTabId[tabId]?.length ?? 0) > 0))
  )
}

// Why: a pane whose PTY is live *right now* already owns its running session
// — e.g. a Pi TUI that finished a turn but stays alive in a background tab.
// Resume must never fork such a pane into a duplicate tab, even when it isn't
// the pane that reconnects on activation. Liveness comes from the runtime
// live-PTY map (ptyIdsByTabId), not the layout's ptyIdsByLeafId snapshot, which
// persists stale across sleep/restart.
function stablePaneHasLivePty(
  tabId: string,
  leafId: string,
  ptyIdsByTabId: Record<string, string[]>,
  layout: TerminalLayoutSnapshot | undefined
): boolean {
  const livePtyIds = ptyIdsByTabId[tabId] ?? []
  if (livePtyIds.length === 0) {
    return false
  }
  const leafPtyId = layout?.ptyIdsByLeafId?.[leafId]
  if (leafPtyId) {
    return livePtyIds.includes(leafPtyId)
  }
  // Single-leaf tabs have no per-leaf binding; the tab's live PTY is this leaf's.
  return layout?.root?.type === 'leaf' && layout.root.leafId === leafId
}

function paneWillConnectOnActivation(
  worktreeId: string,
  tabId: string,
  state: AppStoreState
): boolean {
  if (state.activeWorktreeId !== worktreeId) {
    return false
  }
  // Why: keep-alive mounts every terminal tab of the active worktree and pane
  // connect is not visibility-gated (cold-activation deferral delays a mount,
  // never cancels it), so any preserved restorable pane cold-restores in place.
  // Gating on the visible tab forked a second live surface onto the same
  // provider session for every non-group-active agent tab. Web-mirror tabs are
  // the exception: they never mount a local pane, so they cannot own recovery.
  return !isWebTerminalSurfaceTabId(tabId)
}

export function recordPaneIsOwnedByPreservedPane(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): boolean {
  const worktreeTabs = state.tabsByWorktree[record.worktreeId] ?? []
  const stable = parsePaneKey(record.paneKey)
  if (stable) {
    if (record.tabId && record.tabId !== stable.tabId) {
      return false
    }
    const tabId = record.tabId ?? stable.tabId
    const tab = worktreeTabs.find((candidate) => candidate.id === tabId) ?? null
    if (!tab) {
      return false
    }
    // A crash can remove the terminal layout while leaving the tab and a
    // quit/live recovery row. The tab will mount a fresh leaf and
    // connectPanePty can adopt that row by its stable tab/worktree identity;
    // let the preserved tab own recovery so activation does not fork a second
    // resume tab first. Ownership holds only when this record is the pane's
    // unique adoptable candidate — otherwise adoption fails closed and
    // activation must keep the old fork-a-new-tab recovery. Worktree-sleep
    // records intentionally keep the old behavior when their layout is gone.
    if (!hasMatchingStablePaneLayout(tabId, stable.leafId, state.terminalLayoutsByTabId)) {
      // Why: the O(1) activation gate runs before the O(records) adoption scan;
      // the resume sweep calls this per record (squared via claim-key checks),
      // and both operands are pure reads, so the order only changes cost.
      return (
        (record.origin === 'quit' || record.origin === 'live') &&
        paneWillConnectOnActivation(record.worktreeId, tabId, state) &&
        findUniqueAdoptableRebuiltPaneRecord(state, record.worktreeId, tabId)?.record === record
      )
    }
    if (isPassiveCompletedHibernationEvidence(record)) {
      return true
    }
    // Why: a pane with a live PTY owns its running session regardless of which
    // pane reconnects on activation; forking it would duplicate the session.
    if (
      stablePaneHasLivePty(
        tabId,
        stable.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[tabId]
      )
    ) {
      return true
    }
    // Why: active sessions rely on pane-level cold restore. A preserved leaf
    // without a PTY/session id can repaint scrollback but cannot resume.
    return (
      hasRestorableStablePanePty(
        tab,
        tabId,
        stable.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId
      ) && paneWillConnectOnActivation(record.worktreeId, tabId, state)
    )
  }

  const tabId = getLegacyPaneTabId(record)
  if (!tabId) {
    return false
  }
  const tab = worktreeTabs.find((candidate) => candidate.id === tabId) ?? null
  const providerKeys = getLegacyProviderSessionKeysForTab(state, record.worktreeId, tabId)
  // Why: legacy numeric pane keys lack leaf identity, so only a preserved
  // tab-level wake hint plus a single provider session is strong enough to
  // claim pane recovery without risking the wrong split-pane session.
  return Boolean(
    tab &&
    (tab.ptyId || (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) &&
    providerKeys.size === 1 &&
    paneWillConnectOnActivation(record.worktreeId, tabId, state)
  )
}
