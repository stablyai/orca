// Decision 1's hand-back: when a pane returns to Terminal view, respawn a PTY
// resuming the same OMP session into the exact same pane (not a new tab) —
// the terminal the user is looking at should show their shell again, not an
// unrelated new tab elsewhere. There is no existing generic "respawn into an
// existing pane" primitive; the closest precedent is Codex's detached-pane
// account-restart (codex-detached-pane-restart.ts), whose store rebind
// primitives (`updateTabPtyId` + the terminal-layout leaf rebind) this module
// reuses. `buildAgentResumeStartupPlan` (already the OMP-session-resume path
// used by "wake sleeping agent") builds the actual `omp --resume <id>`
// command — the CLI accepts a bare session id (unlike the RPC wire's
// `switch_session`, which needs the resolved absolute path), so no path
// lookup is needed here.
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { selectNativeChatWorktreeConnectionId } from './native-chat-runtime-owner'
import { canOwnOmpRpcSessionLocally, resolveOmpRpcPaneExecutionHost } from './omp-rpc-pane-locality'
import { useAppStore } from '@/store'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'

export type OmpRpcChatHandbackArgs = {
  paneKey: string
  /** The PTY the RPC child took over — the pane's identity going into the
   *  respawn; killed once the replacement is bound in. */
  replacedPtyId: string
  cwd: string
  /** Bare session id (the claim identity) — sufficient for the CLI's
   *  `--resume`, unlike the RPC wire protocol. */
  sessionId: string
}

export type OmpRpcChatHandbackResult = { ok: true; ptyId: string } | { ok: false; reason: string }

function layoutRootContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutRootContainsLeaf(node.first, leafId) || layoutRootContainsLeaf(node.second, leafId)
}

/** Mirrors codex-detached-pane-restart.ts's `rebindCodexPaneLayoutLeaf`: a
 *  root that doesn't yet name this leaf (e.g. the pane's layout was never
 *  split) mints a fresh single-pane layout instead of silently orphaning the
 *  respawned PTY; an existing split rewrites just this leaf's binding. */
function rebindPaneLayoutLeaf(tabId: string, leafId: string, newPtyId: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  const boundLeafIds = Object.keys(layout?.ptyIdsByLeafId ?? {})
  if (!layoutRootContainsLeaf(layout?.root, leafId) && boundLeafIds.every((id) => id === leafId)) {
    store.setTabLayout(
      tabId,
      singlePaneLayoutSnapshot(leafId, newPtyId, layout?.titlesByLeafId?.[leafId] ?? null)
    )
    return
  }
  store.replaceTerminalLayoutPanePtyId(tabId, leafId, newPtyId)
}

/** The pane this respawn was chosen for, captured BEFORE the async spawn so
 *  the completion has something to re-verify against. */
type HandbackPaneTarget = {
  worktreeId: string
  tabId: string
  leafId: string
  paneKey: string
  replacedPtyId: string
  /** The tab generation that initiated this hand-back. A remount (recovery,
   *  or this module's own rebind below) bumps it, and every such bump hands
   *  the pane to a newer owner. */
  generation: number
}

/** Whether an active RPC ownership attempt precludes a PTY hand-back. Read
 *  immediately BEFORE the spawn as well as after it (XLR-050/XLR-051,
 *  cross-lab review): the post-spawn reap cannot hold the no-overlap
 *  single-writer invariant on its own, because by then `omp --resume` may
 *  already be writing beside the RPC child.
 *
 *  `preparing` is the pre-acquire PTY-settlement window and `pending` begins
 *  synchronously before the acquire IPC call. Both preclude a stale hand-back:
 *  even before main starts the successor child, restoring a PTY would let that
 *  already-authorized acquire start beside it. A refused acquire publishes its
 *  terminal status before invoking its own recovery, so the recovery never
 *  blocks itself. */
function rpcOwnershipPrecludesHandback(paneKey: string): boolean {
  const status = useAppStore.getState().ompRpcChatOwnershipByPaneKey[paneKey]?.status
  return status === 'preparing' || status === 'pending' || status === 'acquired'
}

/** Why (XLR-003, cross-lab review): `pty.spawn` is async, so everything the
 *  target was chosen for can change while it is in flight — the split can
 *  close, the tab can be recycled, or a newer ownership generation can bind
 *  the leaf to its own PTY. Appending to a tab that is no longer this pane's
 *  leaks an orphan process; rebinding a leaf a newer owner holds redirects
 *  the pane away from it. Both fail closed, and the caller reaps the spawn. */
function handbackTargetStaleReason(target: HandbackPaneTarget): string | null {
  const state = useAppStore.getState()
  // Why (XLR-044, cross-lab review): a newer run can ACQUIRE this pane while
  // the spawn is in flight, and an RPC-owned pane leaves its leaf unbound by
  // design — so neither the tab generation nor the leaf binding below can speak
  // for it. Binding a resumed `omp` here would put a second writer on the
  // session the live RPC child owns. Backstop only: the pre-spawn gate is what
  // keeps the launch from happening at all (XLR-050).
  if (rpcOwnershipPrecludesHandback(target.paneKey)) {
    return 'rpc-owner-acquired-during-respawn'
  }
  const tab = state.tabsByWorktree[target.worktreeId]?.find((entry) => entry.id === target.tabId)
  if (!tab) {
    return 'tab-closed-during-respawn'
  }
  if ((tab.generation ?? 0) !== target.generation) {
    return 'tab-remounted-during-respawn'
  }
  const layout = state.terminalLayoutsByTabId[target.tabId]
  const boundPtyId = layout?.ptyIdsByLeafId?.[target.leafId]
  // Acquisition already cleared this leaf's binding, so only "unbound" or
  // "still the PTY we replaced" can still be ours; a third id is a newer
  // owner's and must never be overwritten.
  if (boundPtyId !== undefined && boundPtyId !== target.replacedPtyId) {
    return 'leaf-rebound-during-respawn'
  }
  if (layoutRootContainsLeaf(layout?.root, target.leafId)) {
    return null
  }
  // A root that never named the leaf is the never-split case
  // `rebindPaneLayoutLeaf` mints a fresh single-pane layout for — safe only
  // while no OTHER leaf is bound. Anything else means this leaf's split is
  // gone from the layout.
  return Object.keys(layout?.ptyIdsByLeafId ?? {}).every((id) => id === target.leafId)
    ? null
    : 'leaf-closed-during-respawn'
}

/** The pane's execution owner right now. Read TWICE per hand-back — once to
 *  admit the respawn, once before binding the result (XLR-017, cross-lab
 *  review): `pty.spawn` is async, and a worktree classified local when the
 *  hand-back started can hydrate or be reclassified to an SSH/runtime owner
 *  while it is in flight, without changing the tab generation or the leaf
 *  binding the stale check watches. Binding a locally spawned `omp` into a
 *  remotely owned pane crosses the execution boundary
 *  (docs/reference/ssh-execution-boundary.md) and can resume a same-path local
 *  session unrelated to the remote pane's. */
function resolveHandbackExecutionOwner(worktreeId: string): {
  connectionId: string | null | undefined
  isLocallyOwnable: boolean
  executionHost: string
} {
  const state = useAppStore.getState()
  const connectionId = selectNativeChatWorktreeConnectionId(state, worktreeId)
  const executionHost = resolveOmpRpcPaneExecutionHost({
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId
  })
  return {
    connectionId,
    isLocallyOwnable: canOwnOmpRpcSessionLocally(executionHost),
    executionHost
  }
}

function locateWorktreeIdForTab(tabId: string): string | null {
  const state = useAppStore.getState()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

/** Spawns a PTY resuming `sessionId` and rebinds it into the pane that
 *  `paneKey` identifies, replacing `replacedPtyId`. Never touches any other
 *  pane/tab. Failure is reported, never thrown — the caller degrades by
 *  leaving the pane on its now-exited PTY (the user can restart the shell
 *  manually), consistent with this feature's fail-closed contract. */
export async function respawnPtyForOmpRpcChatHandback(
  args: OmpRpcChatHandbackArgs
): Promise<OmpRpcChatHandbackResult> {
  const parsed = parsePaneKey(args.paneKey)
  if (!parsed || !isTerminalLeafId(parsed.leafId)) {
    return { ok: false, reason: 'invalid-pane-key' }
  }
  const { tabId, leafId } = parsed
  const worktreeId = locateWorktreeIdForTab(tabId)
  if (!worktreeId) {
    return { ok: false, reason: 'tab-not-found' }
  }

  const state = useAppStore.getState()
  // Why (XLR-011, cross-lab review): a hand-back is delayed by however long the
  // release takes to settle, and the pane's execution host can be reclassified
  // in that window. `pty.spawn` picks its provider from `connectionId`, so an
  // omitted one starts `omp` on THIS machine — binding a local child into a
  // pane the store now says a remote host owns, and possibly resuming a
  // same-path session that is not the one the pane held. RPC ownership is only
  // ever granted to a locally executed pane, so anything else (including an
  // unresolved owner, which is not evidence of local — see
  // docs/reference/ssh-execution-boundary.md) fails closed here rather than
  // guessing. The resolved id is then passed to the spawn, so the provider
  // selection is stated rather than defaulted.
  const owner = resolveHandbackExecutionOwner(worktreeId)
  const connectionId = owner.connectionId
  if (!owner.isLocallyOwnable) {
    return { ok: false, reason: `execution-host-not-local:${owner.executionHost}` }
  }
  const target: HandbackPaneTarget = {
    worktreeId,
    tabId,
    leafId,
    paneKey: args.paneKey,
    replacedPtyId: args.replacedPtyId,
    generation: state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.generation ?? 0
  }
  const resumeTarget = resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreePath: args.cwd,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
  const startupPlan = buildAgentResumeStartupPlan({
    agent: 'omp',
    providerSession: { key: 'session_id', id: args.sessionId },
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs('omp', state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv('omp', state.settings?.agentDefaultEnv),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
  })
  if (!startupPlan) {
    return { ok: false, reason: 'resume-plan-unavailable' }
  }

  // Last gate before the launch commits: a successor RPC child that already
  // owns this session must never get a second writer beside it (XLR-050).
  if (rpcOwnershipPrecludesHandback(args.paneKey)) {
    return { ok: false, reason: 'rpc-owner-acquired-before-respawn' }
  }

  let spawned: { id: string }
  try {
    spawned = await window.api.pty.spawn({
      cols: 80,
      rows: 24,
      cwd: args.cwd,
      connectionId,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      command: startupPlan.launchCommand,
      launchAgent: 'omp',
      worktreeId,
      tabId,
      leafId
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  // The spawn is committed; the pane may not be ours to bind anymore. Locality
  // is re-read first (XLR-017) because it is the only check the tab generation
  // and leaf binding cannot speak for.
  const postSpawnOwner = resolveHandbackExecutionOwner(worktreeId)
  const staleReason = !postSpawnOwner.isLocallyOwnable
    ? `execution-host-changed-during-respawn:${postSpawnOwner.executionHost}`
    : handbackTargetStaleReason(target)
  if (staleReason) {
    // Reap the orphaned PTY rather than leave it idling with nothing bound
    // to it (or, worse, bind it over a newer owner's pane).
    void window.api.pty.kill(spawned.id).catch(() => {})
    return { ok: false, reason: staleReason }
  }

  useAppStore.getState().updateTabPtyId(tabId, spawned.id, args.replacedPtyId)
  rebindPaneLayoutLeaf(tabId, leafId, spawned.id)
  void window.api.pty.kill(args.replacedPtyId).catch(() => {})
  // Why (XLR-002, cross-lab review): the store now names the replacement,
  // but the pane's mounted xterm still holds the transport acquisition tore
  // down. Input forwarding and output filtering both key off the transport's
  // OWN pty id, so the new child would run with no terminal able to exchange
  // bytes with it. Bumping the tab generation is this codebase's established
  // remount seam for exactly that (terminal-pane-recovery.ts): the remounted
  // pane reads the leaf binding written just above and REATTACHES to it —
  // `runDeferredSessionReattachChoice` takes the restored-leaf path, never a
  // fresh spawn — instead of painting a dead surface.
  useAppStore.getState().remountTerminalTabForRecovery(tabId)

  return { ok: true, ptyId: spawned.id }
}

const RESPAWN_RETRY_DELAY_MS = 250

/** Bounded second chance for a hand-back respawn: the RPC spawn that just
 *  failed and this respawn launch the same `omp` binary, so a
 *  transient/environmental cause (e.g. memory pressure) can plausibly fail
 *  both back to back. Exactly one retry — never a loop, and never a failure
 *  discarded unread. (See docs/omp-rpc-chat-adapter-plan.md for why proving
 *  the RPC child can spawn before ever killing the PTY is not implemented:
 *  `OmpRpcSessionOwner.acquire()`'s spawn is gated behind `handoffFromPty`'s
 *  exit-proof, a hard precondition, not an ordering choice a caller
 *  controls.) */
export async function respawnPtyForOmpRpcChatHandbackWithRetry(
  args: OmpRpcChatHandbackArgs
): Promise<void> {
  const attempt = (): Promise<OmpRpcChatHandbackResult> =>
    respawnPtyForOmpRpcChatHandback(args).catch((error: unknown): OmpRpcChatHandbackResult => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    }))
  const first = await attempt()
  if (first.ok) {
    return
  }
  await new Promise((resolve) => setTimeout(resolve, RESPAWN_RETRY_DELAY_MS))
  await attempt()
}

/** Undoes `killPtyBeforeOmpRpcAcquire`'s pre-kill renderer mutations when the
 *  stop was refused (XLR-006, cross-lab review). That helper must arm the exit
 *  suppression and erase the tab + layout-leaf bindings BEFORE the kill round
 *  trips — a suppression armed afterwards loses the race with the exit and the
 *  single-pane tab closes — but those mutations are only correct if the PTY
 *  really is going away. When the stop is refused (no `pty.kill` surface, a
 *  throw, or main's own `live`/`unverifiable` verdict) the PTY is still
 *  running while the renderer has already forgotten it: undiscoverable after a
 *  remount, and its eventual real exit would consume the stale suppression and
 *  skip the pane/tab teardown it was owed. This re-points the renderer at the
 *  PTY it never actually lost. Deliberately spawns nothing and does not bump
 *  the tab generation — the id is unchanged, so a mounted transport is still
 *  attached to exactly this child and a remount would only destroy it. */
export function restorePtyBindingsAfterRefusedOmpRpcAcquire(args: {
  paneKey: string
  ptyId: string
}): void {
  const parsed = parsePaneKey(args.paneKey)
  if (!parsed || !isTerminalLeafId(parsed.leafId)) {
    return
  }
  const { tabId, leafId } = parsed
  // Disarmed first and unconditionally: only this acquire armed the flag, and
  // it must not outlive the acquire even when the pane's tab is already gone.
  useAppStore.getState().consumeSuppressedPtyExit(args.ptyId)
  const worktreeId = locateWorktreeIdForTab(tabId)
  if (!worktreeId) {
    return
  }
  const state = useAppStore.getState()
  // Same staleness rule as a respawn's: only an unbound leaf, or one still
  // naming this PTY, is ours to write. The generation read here is current by
  // construction (nothing async happens below it) — the guard that matters is
  // the leaf binding, which a newer owner would already hold.
  const staleReason = handbackTargetStaleReason({
    worktreeId,
    tabId,
    leafId,
    paneKey: args.paneKey,
    replacedPtyId: args.ptyId,
    generation: state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.generation ?? 0
  })
  if (staleReason) {
    return
  }
  state.updateTabPtyId(tabId, args.ptyId)
  rebindPaneLayoutLeaf(tabId, leafId, args.ptyId)
}
