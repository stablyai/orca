import { useAppStore } from '@/store'
import {
  resolveWorktreeOperationRouteResultForHost,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { findActiveRuntimeTerminal } from '@/lib/active-agent-note-target'
import { sendPromptWithGuardedPasteAndEnter } from '@/lib/active-agent-note-send-delivery'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export async function sendCanvasContext(card: DashboardCard, prompt: string): Promise<void> {
  if (!card.executionHostId || !card.leafId || !card.ptyId) {
    throw new Error('The selected agent has no verified terminal target.')
  }
  const state = useAppStore.getState()
  const resolution = resolveWorktreeOperationRouteResultForHost(
    state,
    card.worktreeId,
    card.executionHostId
  )
  if (resolution.kind !== 'resolved') {
    throw new Error('The execution host is unavailable or ambiguous.')
  }
  const target = getActiveRuntimeTarget(
    settingsForWorktreeOperationRoute(state.settings, resolution.route)
  )
  const terminal = await findActiveRuntimeTerminal(
    target,
    card.worktreeId,
    { tabId: card.tabId, leafId: card.leafId },
    8000
  )
  if (!terminal || terminal.ptyId !== card.ptyId) {
    throw new Error('The agent session changed. Select its current session before sending.')
  }
  const result = await sendPromptWithGuardedPasteAndEnter(target, terminal.handle, prompt, {
    allowLegacyFallback: false
  })
  if (result.status !== 'sent') {
    throw new Error(
      activeAgentNotesSendFailureMessage(result.status, { explicitTarget: true, code: result.code })
    )
  }
}
