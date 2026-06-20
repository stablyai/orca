import { useEffect, useState } from 'react'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getSettingsForWorktreeRuntimeOwner,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../shared/types'
import {
  detectAgentStatusFromTitle,
  getAgentLabel,
  isExplicitAgentStatusFresh
} from './agent-status'
import { resolveRuntimePaneTitleForLeaf } from './runtime-pane-title-leaf-id'

const ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS = 3000
const ACTIVE_AGENT_TERMINAL_LIST_LIMIT = 200

export type ActiveTerminalNoteTarget = {
  tabId: string
  leafId: string
}

export type ActiveTerminalNoteTargetState = {
  activeWorktreeId: AppState['activeWorktreeId']
  activeTabType: AppState['activeTabType']
  activeTabId: AppState['activeTabId']
  activeTabIdByWorktree: AppState['activeTabIdByWorktree']
  tabsByWorktree: Record<
    string,
    readonly { id: string; title?: string; launchAgent?: unknown }[] | undefined
  >
  ptyIdsByTabId?: Record<string, readonly string[] | undefined>
  terminalLayoutsByTabId: Record<
    string,
    | {
        activeLeafId: string | null
        root?: TerminalLayoutSnapshot['root']
        ptyIdsByLeafId?: Record<string, string | undefined>
      }
    | undefined
  >
  runtimePaneTitlesByTabId?: Record<string, Record<number, string> | undefined>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry | undefined>
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
} & Pick<WorktreeRuntimeOwnerState, 'repos' | 'worktreesByRepo'>

type ActiveAgentRuntimeProbeDescriptor = {
  key: string
  worktreeId: string
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>
  noteTarget: ActiveTerminalNoteTarget
}

export function getActiveTerminalNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string
): ActiveTerminalNoteTarget | null {
  if (state.activeWorktreeId !== worktreeId) {
    return null
  }

  const tabId =
    state.activeTabType === 'terminal'
      ? (state.activeTabId ?? state.activeTabIdByWorktree[worktreeId])
      : state.activeTabIdByWorktree[worktreeId]
  if (!tabId || !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    return null
  }

  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  return leafId ? { tabId, leafId } : null
}

export function useCanSendNotesToActiveTerminal(worktreeId: string): boolean {
  const canSendFromRendererState = useAppStore(
    (state) => getActiveAgentNoteTarget(state, worktreeId) !== null
  )
  const probeKey = useAppStore(
    (state) => getActiveAgentRuntimeProbeDescriptor(state, worktreeId)?.key ?? null
  )
  const [runtimeProbe, setRuntimeProbe] = useState<{ key: string; canSend: boolean } | null>(null)

  useEffect(() => {
    if (canSendFromRendererState || !probeKey) {
      return
    }
    const probeDescriptor = getActiveAgentRuntimeProbeDescriptor(useAppStore.getState(), worktreeId)
    if (!probeDescriptor || probeDescriptor.key !== probeKey) {
      return
    }

    let cancelled = false
    void probeActiveAgentNoteTarget(probeDescriptor)
      .then((canSend) => {
        if (!cancelled) {
          setRuntimeProbe({ key: probeKey, canSend })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeProbe({ key: probeKey, canSend: false })
        }
      })

    return () => {
      cancelled = true
    }
  }, [canSendFromRendererState, probeKey, worktreeId])

  return (
    canSendFromRendererState ||
    (runtimeProbe !== null && runtimeProbe.key === probeKey && runtimeProbe.canSend)
  )
}

export function getActiveAgentNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  now = Date.now()
): ActiveTerminalNoteTarget | null {
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget || !isTerminalLeafId(noteTarget.leafId)) {
    return null
  }

  const activePtyId = getActivePanePtyId(state, noteTarget)
  if (!activePtyId) {
    return null
  }

  const entry = state.agentStatusByPaneKey?.[makePaneKey(noteTarget.tabId, noteTarget.leafId)]
  if (entry && isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return noteTarget
  }
  // Why: freshly opened agents can be idle before their first hook event. Use
  // renderer title/launch hints only to show the option; runtime still verifies
  // the focused terminal is an idle agent before sending Enter.
  if (!hasFocusedPaneAgentHint(state, worktreeId, noteTarget)) {
    return null
  }

  return noteTarget
}

export function getActiveAgentRuntimeProbeDescriptor(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string
): ActiveAgentRuntimeProbeDescriptor | null {
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget || !isTerminalLeafId(noteTarget.leafId)) {
    return null
  }
  const activePtyId = getActivePanePtyId(state, noteTarget)
  if (!activePtyId) {
    return null
  }
  // Route by the worktree's owner host so the probe targets the host that runs
  // this worktree's agent terminal, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  )
  const runtimeKey =
    runtimeTarget.kind === 'environment' ? `env:${runtimeTarget.environmentId}` : 'local'
  return {
    key: `${runtimeKey}:${worktreeId}:${noteTarget.tabId}:${noteTarget.leafId}:${activePtyId}`,
    worktreeId,
    runtimeTarget,
    noteTarget
  }
}

export async function probeActiveAgentNoteTarget({
  worktreeId,
  runtimeTarget,
  noteTarget
}: ActiveAgentRuntimeProbeDescriptor): Promise<boolean> {
  const terminal = await findActiveRuntimeTerminal(
    runtimeTarget,
    worktreeId,
    noteTarget,
    ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS
  )
  if (!terminal) {
    return false
  }
  const agentCheck = await callRuntimeRpc<{ isRunningAgent: boolean }>(
    runtimeTarget,
    'terminal.isRunningAgent',
    { terminal: terminal.handle },
    { timeoutMs: ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS }
  )
  return agentCheck.isRunningAgent
}

export async function findActiveRuntimeTerminal(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget,
  timeoutMs: number
): Promise<RuntimeTerminalListResult['terminals'][number] | null> {
  const { terminals } = await callRuntimeRpc<RuntimeTerminalListResult>(
    runtimeTarget,
    'terminal.list',
    // Why: worktree ids can look like branch names or paths; keep the lookup unambiguous.
    { worktree: toRuntimeWorktreeSelector(worktreeId), limit: ACTIVE_AGENT_TERMINAL_LIST_LIMIT },
    { timeoutMs }
  )
  return (
    terminals.find(
      (terminal) => terminal.tabId === noteTarget.tabId && terminal.leafId === noteTarget.leafId
    ) ?? null
  )
}

function getActivePanePtyId(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  const livePtyIds = state.ptyIdsByTabId?.[noteTarget.tabId] ?? []
  if (livePtyIds.length === 0) {
    return null
  }

  const ptyIdsByLeafId = state.terminalLayoutsByTabId[noteTarget.tabId]?.ptyIdsByLeafId
  if (ptyIdsByLeafId && Object.keys(ptyIdsByLeafId).length > 0) {
    const activeLeafPtyId = ptyIdsByLeafId[noteTarget.leafId]
    // Why: layout maps can survive sleep/reconnect; ptyIdsByTabId is the live
    // PTY source of truth for whether submitting with Enter is currently safe.
    return activeLeafPtyId && livePtyIds.includes(activeLeafPtyId) ? activeLeafPtyId : null
  }
  return livePtyIds[0] ?? null
}

function hasFocusedPaneAgentHint(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget
): boolean {
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
    (entry) => entry.id === noteTarget.tabId
  )
  const runtimeTitle = getFocusedRuntimePaneTitle(state, noteTarget)
  if (runtimeTitle !== null) {
    return isRecognizedAgentTitle(runtimeTitle)
  }
  if (tab?.launchAgent) {
    return true
  }

  return tab?.title ? isRecognizedAgentTitle(tab.title) : false
}

function getFocusedRuntimePaneTitle(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  return resolveRuntimePaneTitleForLeaf(
    state.terminalLayoutsByTabId[noteTarget.tabId],
    state.runtimePaneTitlesByTabId?.[noteTarget.tabId],
    noteTarget.leafId
  )
}

function isRecognizedAgentTitle(title: string): boolean {
  return detectAgentStatusFromTitle(title) !== null && getAgentLabel(title) !== null
}
