import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type {
  RuntimeTerminalAttention,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { resolveTerminalPtyOwner } from '../../workspace/ownership/terminal-worktree-route'
import {
  toAgentHibernationRuntimeOwner,
  type AgentHibernationRuntimeOwner
} from './agent-hibernation-runtime-owner'
import { getEntryTabId } from './agent-hibernation-pane-eligibility'

export type HostPtyEvidence = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
  /** Per worktree, keyed by its host's PTY id: two hosts can reuse one PTY id. Only hosts that report attention contribute. */
  attentionByWorktreeId: Record<string, Record<string, RuntimeTerminalAttention>>
}

const NO_TABS: readonly TerminalTab[] = []
const worktreePtyIdsByTabs = new WeakMap<
  readonly TerminalTab[],
  { bindings: AppState['ptyIdsByTabId']; ptyIds: readonly string[] }
>()

/** A workspace's bound PTYs, walked once per tabs array and binding map, so a drain's checks share it. */
function worktreePtyIds(state: AppState, worktreeId: string): readonly string[] {
  const tabs = state.tabsByWorktree[worktreeId] ?? NO_TABS
  const cached = worktreePtyIdsByTabs.get(tabs)
  if (cached?.bindings === state.ptyIdsByTabId) {
    return cached.ptyIds
  }
  const ptyIds = tabs.flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
  worktreePtyIdsByTabs.set(tabs, { bindings: state.ptyIdsByTabId, ptyIds })
  return ptyIds
}

const ambiguousOwnerByPtyIds = new WeakMap<readonly string[], AgentHibernationRuntimeOwner>()

export function resolveAgentHibernationRuntimeOwner(
  state: AppState,
  worktreeId: string
): AgentHibernationRuntimeOwner {
  const worktreeOwner = resolveTerminalPtyOwner(state, worktreeId)
  if (worktreeOwner.kind !== 'ambiguous') {
    return toAgentHibernationRuntimeOwner(worktreeOwner, [])
  }
  // Only a workspace two hosts publish needs its PTYs to name the owner; settled once per PTY list.
  const ptyIds = worktreePtyIds(state, worktreeId)
  let owner = ambiguousOwnerByPtyIds.get(ptyIds)
  if (!owner) {
    owner = toAgentHibernationRuntimeOwner(worktreeOwner, ptyIds)
    ambiguousOwnerByPtyIds.set(ptyIds, owner)
  }
  return owner
}

/** Worktree → owning runtime; `null` means liveness is required but no host can be asked. */
export function getRuntimeLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string,
  targetOwner?: AgentHibernationRuntimeOwner
): Map<string, string | null> {
  const targets = new Map<string, string | null>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const owner = targetOwner ?? resolveAgentHibernationRuntimeOwner(state, worktreeId)
    if (owner.kind !== 'non-runtime') {
      targets.set(worktreeId, owner.kind === 'runtime' ? owner.environmentId : null)
    }
  }
  return targets
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

/** `onlyPaneKey` narrows the completed-agent evidence to that pane, for a one-pane re-check. */
export async function collectHostPtyEvidence(
  state: AppState,
  targetWorktreeId?: string,
  onlyPaneKey?: string,
  targetOwner?: AgentHibernationRuntimeOwner
): Promise<HostPtyEvidence> {
  const targets = getRuntimeLivenessTargetWorktrees(state, targetWorktreeId, targetOwner)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeLivenessRequiredWorktreeIds = [...targets.keys()]
  const attentionByWorktreeId: HostPtyEvidence['attentionByWorktreeId'] = {}
  const completedTabIds = new Set<string>()
  const entries =
    onlyPaneKey === undefined
      ? Array.from(state.agentStatusByPaneKey.values())
      : [state.agentStatusByPaneKey.get(onlyPaneKey)]
  for (const entry of entries) {
    const tabId = entry?.state === 'done' ? getEntryTabId(entry) : null
    if (tabId) {
      completedTabIds.add(tabId)
    }
  }
  // Why: only completed agents can sleep, so idle installs ask nothing.
  if (completedTabIds.size === 0) {
    return {
      runtimeLivePtyIdsByWorktreeId,
      runtimeLivenessRequiredWorktreeIds,
      attentionByWorktreeId
    }
  }
  const localPtyIds =
    onlyPaneKey !== undefined && targetWorktreeId !== undefined
      ? collectPaneLocalPtyIds(state, targets, onlyPaneKey, targetWorktreeId)
      : collectLocalCompletedPtyIds(state, targets, completedTabIds, targetWorktreeId)
  await Promise.all([
    collectLocalTerminalAttention(localPtyIds, attentionByWorktreeId),
    ...[...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      // A one-pane check's completed tab is its own, in this workspace: no walk of the workspace's tabs.
      if (
        !runtimeEnvironmentId ||
        (onlyPaneKey === undefined &&
          !state.tabsByWorktree[worktreeId]?.some((tab) => completedTabIds.has(tab.id)))
      ) {
        // Skipped owners still require host evidence if an agent completes during this pass.
        return
      }
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.list',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            limit: 10_000,
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false,
            includeAttention: true
          },
          // A periodic evidence pass: no use of an idle WSL host (#46567).
          { timeoutMs: 10_000, background: true }
        )
        if (result.truncated) {
          return
        }
        const ptyIds = new Set<string>()
        const attention: Record<string, RuntimeTerminalAttention> = {}
        for (const terminal of result.terminals) {
          if (!terminal.connected || terminal.worktreeId !== worktreeId) {
            continue
          }
          const ptyId = getTypedRuntimePtyId(terminal)
          if (ptyId) {
            ptyIds.add(ptyId)
            if (terminal.attention) {
              attention[ptyId] = terminal.attention
            }
          }
        }
        runtimeLivePtyIdsByWorktreeId[worktreeId] = [...ptyIds].sort()
        attentionByWorktreeId[worktreeId] = attention
      } catch {
        // Omit stale runtime evidence so the planner fails closed for this pass.
      }
    })
  ])
  return {
    runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds,
    attentionByWorktreeId
  }
}

function collectLocalCompletedPtyIds(
  state: AppState,
  runtimeTargets: Map<string, string | null>,
  completedTabIds: Set<string>,
  targetWorktreeId?: string
): Map<string, string[]> {
  const worktreeIds = targetWorktreeId ? [targetWorktreeId] : Object.keys(state.tabsByWorktree)
  const ptyIdsByWorktreeId = new Map<string, string[]>()
  for (const worktreeId of worktreeIds) {
    const ptyIds = runtimeTargets.has(worktreeId)
      ? []
      : (state.tabsByWorktree[worktreeId] ?? [])
          .filter((tab) => completedTabIds.has(tab.id))
          .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
    if (ptyIds.length > 0) {
      ptyIdsByWorktreeId.set(worktreeId, ptyIds)
    }
  }
  return ptyIdsByWorktreeId
}

/** A one-pane re-check's own process: not its tab's other panes, nor the workspace's other tabs. */
function collectPaneLocalPtyIds(
  state: AppState,
  runtimeTargets: Map<string, string | null>,
  paneKey: string,
  worktreeId: string
): Map<string, string[]> {
  const pane = parsePaneKey(paneKey)
  const ptyId = pane
    ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
    : null
  return ptyId && !runtimeTargets.has(worktreeId) ? new Map([[worktreeId, [ptyId]]]) : new Map()
}

/** This window's own PTYs can also be shown or typed into by paired clients and phones. */
async function collectLocalTerminalAttention(
  ptyIdsByWorktreeId: Map<string, string[]>,
  attentionByWorktreeId: HostPtyEvidence['attentionByWorktreeId']
): Promise<void> {
  if (ptyIdsByWorktreeId.size === 0) {
    return
  }
  try {
    const attention = await window.api.pty.getTerminalAttention(
      [...ptyIdsByWorktreeId.values()].flat()
    )
    for (const [worktreeId, ptyIds] of ptyIdsByWorktreeId) {
      attentionByWorktreeId[worktreeId] = Object.fromEntries(
        ptyIds.flatMap((ptyId) => (attention[ptyId] ? [[ptyId, attention[ptyId]]] : []))
      )
    }
  } catch {
    // No attention evidence leaves only this window's view and input, as before.
  }
}
