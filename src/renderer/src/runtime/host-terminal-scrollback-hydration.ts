import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { SessionReadTerminalScrollbackResult } from '../../../shared/rpc-contract/session-terminal-scrollback-params'
import { SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import {
  callRuntimeRpc,
  peekRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { hasRegisteredRuntimeTerminalTab } from './mounted-terminal-tab-registry'

// Why bounded: a slow or unreachable host must never keep a terminal from mounting.
export const HOST_TERMINAL_SCROLLBACK_HOLD_MS = 3_000

// Answers that will not change on retry; anything else (transport, timeout, abort) may.
const DEFINITE_READ_FAILURE_CODES = [
  'terminal_scrollback_not_found',
  'terminal_scrollback_too_large'
]

export type HostTerminalScrollbackTabState = {
  layout: TerminalLayoutSnapshot | undefined
  localOnly: Record<string, string> | undefined
}

export type HostTerminalScrollbackHydrationDeps = {
  getTabState: (tabId: string) => HostTerminalScrollbackTabState
  /** Null for a pane this machine runs; such panes never ask a host. */
  resolveEnvironmentId: (worktreeId: string) => string | null
  /** Stat-only check of this client's own snapshot store; web clients have none. */
  hasLocalSnapshot: (ref: string) => boolean
  /** Cached verdict only; undefined when this client has no fresh status for the host. */
  peekHostSupportsRead: (environmentId: string) => boolean | undefined
  /** Fetches the host's status so a later peek answers. */
  warmHostSupportsRead: (environmentId: string) => Promise<unknown>
  readHostSnapshot: (
    environmentId: string,
    worktreeId: string,
    ref: string,
    signal: AbortSignal
  ) => Promise<string>
  isTabMounted: (tabId: string) => boolean
  storeLocalOnly: (tabId: string, buffersByLeafId: Record<string, string>) => void
}

type HostScrollbackLeaf = { leafId: string; ref: string }
type HostScrollbackPlan = {
  environmentId: string
  leaves: HostScrollbackLeaf[]
}
type FetchedHostScrollbackLeaf = HostScrollbackLeaf & { buffer: string | null }

const defaultDeps: HostTerminalScrollbackHydrationDeps = {
  getTabState: (tabId) => {
    const state = useAppStore.getState()
    return {
      layout: state.terminalLayoutsByTabId[tabId],
      localOnly: state.localOnlyScrollbackByTabId[tabId]
    }
  },
  resolveEnvironmentId: (worktreeId) => {
    const owner = runtimeEnvironmentIdForWorkspaceOwner(useAppStore.getState(), {
      workspaceId: worktreeId
    })
    // Why null for a twin: no single host owns the stored scrollback, so the pane paints locally.
    return owner.kind === 'resolved' ? owner.environmentId : null
  },
  hasLocalSnapshot: (ref) => {
    try {
      return window.api.session.hasTerminalScrollback({ ref })
    } catch {
      return false
    }
  },
  peekHostSupportsRead: (environmentId) =>
    peekRuntimeEnvironmentCapability(
      environmentId,
      SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY
    ),
  warmHostSupportsRead: (environmentId) =>
    runtimeEnvironmentSupportsCapability(
      environmentId,
      SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY
    ),
  readHostSnapshot: async (environmentId, worktreeId, ref, signal) =>
    (
      await callRuntimeRpc<SessionReadTerminalScrollbackResult>(
        { kind: 'environment', environmentId },
        'session.readTerminalScrollback',
        { worktree: toRuntimeWorktreeSelector(worktreeId), ref },
        { timeoutMs: HOST_TERMINAL_SCROLLBACK_HOLD_MS, signal }
      )
    ).buffer,
  isTabMounted: (tabId) => hasRegisteredRuntimeTerminalTab(tabId),
  storeLocalOnly: (tabId, buffersByLeafId) =>
    useAppStore.getState().setTabLocalOnlyScrollback(tabId, buffersByLeafId)
}

// Why: a pane snapshot with a definite answer is never asked for again, so it never holds a mount twice.
const settledKeys = new Set<string>()
// Why: a known local copy needs no further stat IPC on remount.
const localSnapshotRefs = new Set<string>()
const inFlightByTabId = new Map<string, Promise<void>>()
const warmingEnvironmentIds = new Set<string>()

function attemptKey(environmentId: string, tabId: string, ref: string): string {
  return `${environmentId}\0${tabId}\0${ref}`
}

function hasLocalSnapshotCached(ref: string, deps: HostTerminalScrollbackHydrationDeps): boolean {
  if (localSnapshotRefs.has(ref)) {
    return true
  }
  if (!deps.hasLocalSnapshot(ref)) {
    return false
  }
  localSnapshotRefs.add(ref)
  return true
}

function warmCapability(environmentId: string, deps: HostTerminalScrollbackHydrationDeps): void {
  if (warmingEnvironmentIds.has(environmentId)) {
    return
  }
  warmingEnvironmentIds.add(environmentId)
  void Promise.resolve()
    .then(() => deps.warmHostSupportsRead(environmentId))
    .catch(() => {})
    .finally(() => warmingEnvironmentIds.delete(environmentId))
}

function planHostScrollbackHydration(
  tabId: string,
  worktreeId: string,
  deps: HostTerminalScrollbackHydrationDeps
): HostScrollbackPlan | null {
  const { layout, localOnly } = deps.getTabState(tabId)
  const refs = Object.entries(layout?.scrollbackRefsByLeafId ?? {}).filter(
    ([leafId]) =>
      // Why: a live PTY repaints its own screen, which replaces restored history anyway.
      layout?.ptyIdsByLeafId?.[leafId] === undefined &&
      layout?.buffersByLeafId?.[leafId] === undefined &&
      localOnly?.[leafId] === undefined
  )
  if (refs.length === 0) {
    return null
  }
  const environmentId = deps.resolveEnvironmentId(worktreeId)
  if (!environmentId) {
    return null
  }
  const leaves = refs
    .filter(
      ([, ref]) =>
        !settledKeys.has(attemptKey(environmentId, tabId, ref)) &&
        !hasLocalSnapshotCached(ref, deps)
    )
    .map(([leafId, ref]) => ({ leafId, ref }))
  if (leaves.length === 0) {
    return null
  }
  // Why: holding on an unknown host would cost every mount a status round trip; mount now and
  // learn the answer in the background so later mounts can hold.
  const supported = deps.peekHostSupportsRead(environmentId)
  if (supported === undefined) {
    warmCapability(environmentId, deps)
  }
  return supported === true ? { environmentId, leaves } : null
}

async function readLeaf(
  tabId: string,
  worktreeId: string,
  environmentId: string,
  leaf: HostScrollbackLeaf,
  signal: AbortSignal,
  deps: HostTerminalScrollbackHydrationDeps
): Promise<FetchedHostScrollbackLeaf> {
  try {
    const buffer = await deps.readHostSnapshot(environmentId, worktreeId, leaf.ref, signal)
    return { ...leaf, buffer }
  } catch (error) {
    if (DEFINITE_READ_FAILURE_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))) {
      settledKeys.add(attemptKey(environmentId, tabId, leaf.ref))
    }
    return { ...leaf, buffer: null }
  }
}

async function fetchHostScrollback(
  tabId: string,
  worktreeId: string,
  plan: HostScrollbackPlan,
  deps: HostTerminalScrollbackHydrationDeps
): Promise<void> {
  const controller = new AbortController()
  // Why: the hold releases at this bound; bytes after it would land behind a mounted pane.
  const deadline = setTimeout(() => controller.abort(), HOST_TERMINAL_SCROLLBACK_HOLD_MS)
  let fetched: FetchedHostScrollbackLeaf[]
  try {
    fetched = await Promise.all(
      plan.leaves.map((leaf) =>
        readLeaf(tabId, worktreeId, plan.environmentId, leaf, controller.signal, deps)
      )
    )
  } finally {
    clearTimeout(deadline)
  }
  // Why: a mounted pane's xterm already owns its bytes; its next park captures them instead.
  if (controller.signal.aborted || deps.isTabMounted(tabId)) {
    return
  }
  const { layout, localOnly } = deps.getTabState(tabId)
  const next = { ...localOnly }
  const stored: HostScrollbackLeaf[] = []
  for (const { leafId, ref, buffer } of fetched) {
    if (
      buffer &&
      layout?.scrollbackRefsByLeafId?.[leafId] === ref &&
      layout.buffersByLeafId?.[leafId] === undefined &&
      next[leafId] === undefined
    ) {
      next[leafId] = buffer
      stored.push({ leafId, ref })
    }
  }
  if (stored.length > 0) {
    deps.storeLocalOnly(tabId, next)
    for (const { ref } of stored) {
      settledKeys.add(attemptKey(plan.environmentId, tabId, ref))
    }
  }
}

/**
 * Starts reading a host-run tab's stored scrollback from its host when this client has no copy,
 * so the pane paints its history after a move deleted (or a web client never had) the local one.
 * Decides synchronously and holds only for a host already known to serve the read; returns null
 * when there is nothing to fetch. The promise never rejects and settles by the hold bound.
 */
export function startHostTerminalScrollbackHydration(
  tabId: string,
  worktreeId: string,
  deps: HostTerminalScrollbackHydrationDeps = defaultDeps
): Promise<void> | null {
  const inFlight = inFlightByTabId.get(tabId)
  if (inFlight) {
    return inFlight
  }
  const plan = planHostScrollbackHydration(tabId, worktreeId, deps)
  if (!plan) {
    return null
  }
  const pending = fetchHostScrollback(tabId, worktreeId, plan, deps)
    .catch(() => {})
    .finally(() => inFlightByTabId.delete(tabId))
  inFlightByTabId.set(tabId, pending)
  return pending
}

export function resetHostTerminalScrollbackHydrationForTests(): void {
  settledKeys.clear()
  localSnapshotRefs.clear()
  inFlightByTabId.clear()
  warmingEnvironmentIds.clear()
}
