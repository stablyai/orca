import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import type { RuntimeTerminalAttention } from '../../../shared/runtime-terminal-contracts'
import { resolveTerminalPtyOwner } from './terminal-worktree-route'
import { toAgentHibernationRuntimeOwner } from './agent-hibernation-runtime-owner'
import { getEntryTabId } from './agent-hibernation-pane-eligibility'

export type HostPtyEvidence = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
  /** Per worktree, keyed by its host's PTY id: two hosts can reuse one PTY id. Only hosts that report attention contribute. */
  attentionByWorktreeId: Record<string, Record<string, RuntimeTerminalAttention>>
}

export function resolveAgentHibernationRuntimeOwner(state: AppState, worktreeId: string) {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const ptyIds = tabs.flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
  return toAgentHibernationRuntimeOwner(resolveTerminalPtyOwner(state, worktreeId), ptyIds)
}

/** Worktree → owning runtime; `null` means liveness is required but no host can be asked. */
export function getRuntimeLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string
): Map<string, string | null> {
  const targets = new Map<string, string | null>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const owner = resolveAgentHibernationRuntimeOwner(state, worktreeId)
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

export async function collectHostPtyEvidence(
  state: AppState,
  targetWorktreeId?: string
): Promise<HostPtyEvidence> {
  const targets = getRuntimeLivenessTargetWorktrees(state, targetWorktreeId)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeLivenessRequiredWorktreeIds = [...targets.keys()]
  const attentionByWorktreeId: HostPtyEvidence['attentionByWorktreeId'] = {}
  const completedTabIds = new Set<string>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
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
  const localPtyIds = collectLocalCompletedPtyIds(state, targets, completedTabIds, targetWorktreeId)
  await Promise.all([
    collectLocalTerminalAttention(localPtyIds, attentionByWorktreeId),
    ...[...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      if (
        !runtimeEnvironmentId ||
        !state.tabsByWorktree[worktreeId]?.some((tab) => completedTabIds.has(tab.id))
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
          { timeoutMs: 10_000 }
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
