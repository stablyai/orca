import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { findAgentRowParentTerminal, startAgentRowIntent } from './agent-row-parent-terminal'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import type { CodexAgentViewResult } from '../../../shared/rpc-contract/terminal-codex-agent-view-params'

const pending = new Map<string, AbortController>()

function observedKeys() {
  const keys = new Set<string>()
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    has: (key: string): boolean => keys.has(key),
    set(key: string, value: boolean) {
      if (keys.has(key) === value) {
        return
      }
      keys[value ? 'add' : 'delete'](key)
      for (const listener of listeners) {
        listener()
      }
    },
    use(key: string | undefined): boolean {
      const read = () => key !== undefined && keys.has(key)
      return useSyncExternalStore(subscribe, read, read)
    }
  }
}

// Child ids whose switch is in flight long enough to show; rows render a spinner for these.
const opening = observedKeys()
// Panes whose Codex may be driven through /subagents; their input is dropped meanwhile.
const switchingPanes = observedKeys()
// Switches still running after a beat; the pane covers that keystroke churn without flashing quick no-ops.
const coveredPanes = observedKeys()
const openingOwners = new Map<string, object>()
const SHOW_DELAY_MS = 200
// Local RPCs have no timeout; match the remote cap so a stalled switch cannot hold the pane.
const SWITCH_CAP_MS = 10000

export const useCodexChildOpening = (childId: string | undefined): boolean => opening.use(childId)

export const useCodexAgentSwitching = (paneKey: string): boolean => coveredPanes.use(paneKey)

export const isCodexAgentSwitching = (paneKey: string): boolean => switchingPanes.has(paneKey)

const rowChildId = (agent: DashboardAgentRow): string | undefined =>
  agent.rowSource === 'subagent' && agent.childRow?.kind === 'agent'
    ? (agent.childRow.providerId ?? agent.childRow.id)
    : undefined

export const useCodexChildRowOpening = (agent: DashboardAgentRow): boolean =>
  useCodexChildOpening(rowChildId(agent))

function reportFailure(status: CodexAgentViewResult['status']): void {
  if (status === 'viewed') {
    return
  }
  toast.info(
    status === 'draft'
      ? translate('codex.agentView.draft', 'Clear the Codex message box before switching agents.')
      : status === 'permission'
        ? translate(
            'codex.agentView.permission',
            'Answer Codex’s approval prompt before switching agents.'
          )
        : status === 'not_listed'
          ? translate('codex.agentView.finished', 'This Codex agent is no longer running.')
          : translate(
              'codex.agentView.unavailable',
              'Codex could not switch to this agent. Try /subagents in the Codex pane.'
            )
  )
}

/** Shows the parent pane, then switches its Codex to the clicked thread, as Claude rows do. */
export async function viewCodexChildFromRow(
  agent: DashboardAgentRow,
  activateParent: () => void
): Promise<void> {
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  activateParent()
  const parent = useAppStore.getState().agentStatusByPaneKey[paneKey]
  if (parent?.agentType !== 'codex' || parent.structuredHostOwned) {
    return
  }
  const childId = rowChildId(agent)
  // Command, monitor, and workflow children have no Codex thread to switch to.
  if (agent.rowSource === 'subagent' && !childId) {
    return
  }
  // Parent rows return quietly; a failed return leaves the child showing, which the user sees.
  await viewCodexAgent(agent.tab.worktreeId, paneKey, childId, childId ? reportFailure : () => {})
}

/** The one live parent pane in the active worktree that a recorded child can show in. */
export function recordedCodexChildParent(
  state: Pick<AppState, 'agentStatusByPaneKey' | 'activeWorktreeId'>,
  session: AiVaultSession
): AgentStatusEntry | null {
  if (session.agent !== 'codex' || !session.subagent) {
    return null
  }
  const parents = Object.values(state.agentStatusByPaneKey).filter(
    (parent) =>
      parent.agentType === 'codex' &&
      !parent.structuredHostOwned &&
      parent.providerSession?.id === session.subagent?.parentSessionId &&
      parent.worktreeId === state.activeWorktreeId
  )
  return parents.length === 1 && parents[0].worktreeId ? parents[0] : null
}

export async function viewRecordedCodexChild(session: AiVaultSession): Promise<void> {
  const parent = recordedCodexChildParent(useAppStore.getState(), session)
  if (!parent?.worktreeId) {
    reportFailure('unavailable')
    return
  }
  await viewCodexAgent(parent.worktreeId, parent.paneKey, session.sessionId, reportFailure, true)
}

async function viewCodexAgent(
  worktreeId: string,
  paneKey: string,
  agentId: string | undefined,
  fail: (status: CodexAgentViewResult['status']) => void,
  focusParent = false
): Promise<void> {
  const intent = startAgentRowIntent(pending, paneKey)
  const owner = {}
  if (agentId) {
    openingOwners.set(agentId, owner)
  }
  const showOpening = setTimeout(() => {
    if (agentId) {
      opening.set(agentId, true)
    }
    if (intent.latest() && switchingPanes.has(paneKey)) {
      coveredPanes.set(paneKey, true)
    }
  }, SHOW_DELAY_MS)
  let capSwitch: ReturnType<typeof setTimeout> | undefined
  try {
    const sessionId = useAppStore.getState().agentStatusByPaneKey[paneKey]?.providerSession?.id
    if (!sessionId) {
      fail('unavailable')
      return
    }
    const parent = await findAgentRowParentTerminal({
      intent,
      agentType: 'codex',
      paneKey,
      worktreeId,
      sessionId
    })
    if (parent.status !== 'found') {
      if (parent.status === 'unavailable') {
        fail('unavailable')
      }
      return
    }
    if (focusParent) {
      await callRuntimeRpc(
        parent.target,
        'terminal.focus',
        { terminal: parent.handle },
        parent.options
      )
    }
    switchingPanes.set(paneKey, true)
    // A child switch always drives keys; only parent returns can be quick no-ops.
    if (agentId) {
      coveredPanes.set(paneKey, true)
    }
    capSwitch = setTimeout(() => {
      if (intent.latest()) {
        switchingPanes.set(paneKey, false)
        coveredPanes.set(paneKey, false)
      }
    }, SWITCH_CAP_MS)
    const { view } = await callRuntimeRpc<{ view: CodexAgentViewResult }>(
      parent.target,
      'terminal.viewCodexAgent',
      {
        terminal: parent.handle,
        sessionId,
        ...(agentId ? { agentId } : {}),
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      // The switch types into Codex and waits for its picker on each side.
      { timeoutMs: 10000, ...parent.options }
    )
    if (parent.current()) {
      fail(view.status)
    }
  } catch {
    if (intent.latest()) {
      fail('unavailable')
    }
  } finally {
    clearTimeout(showOpening)
    clearTimeout(capSwitch)
    // A superseded click must not clear the spinner of a newer switch to the same child.
    if (agentId && openingOwners.get(agentId) === owner) {
      openingOwners.delete(agentId)
      opening.set(agentId, false)
    }
    if (intent.latest()) {
      switchingPanes.set(paneKey, false)
      coveredPanes.set(paneKey, false)
    }
    intent.finish()
  }
}
