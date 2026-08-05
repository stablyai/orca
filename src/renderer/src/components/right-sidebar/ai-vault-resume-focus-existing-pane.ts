import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { isPassiveCompletedHibernationEvidence } from '@/lib/sleeping-agent-pane-ownership'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  resolveOriginalPaneTarget,
  type AiVaultOriginalPaneTarget,
  type OriginalPaneState
} from './ai-vault-original-pane'
import { focusAiVaultOriginalPaneTarget } from './ai-vault-original-pane-actions'
import { agentLabel } from './ai-vault-session-filters'

/**
 * The pane whose session is genuinely live for this vault row, or null.
 * Why: unlike the Jump affordance, this lookup gates whether Resume launches at
 * all, so it must not guess — exact provider-session matches only (no prompt
 * heuristics), and never a passive completed-hibernation record: that pane
 * holds display history, not a process, and focusing it would silently swallow
 * the resume the user asked for.
 */
export function findLiveAiVaultSessionPane(
  state: OriginalPaneState,
  session: AiVaultSession
): AiVaultOriginalPaneTarget | null {
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (session.agent === entry.agentType && session.sessionId === entry.providerSession?.id) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: entry.paneKey,
        worktreeIdHint: entry.worktreeId,
        tabIdHint: entry.tabId
      })
      if (target) {
        return target
      }
    }
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (
      session.agent === retained.agentType &&
      session.sessionId === retained.entry.providerSession?.id
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: retained.entry.paneKey,
        worktreeIdHint: retained.worktreeId,
        tabIdHint: retained.entry.tabId ?? retained.tab.id
      })
      if (target) {
        return target
      }
    }
  }
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (
      session.agent === record.agent &&
      session.sessionId === record.providerSession.id &&
      !isPassiveCompletedHibernationEvidence(record)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: record.paneKey,
        worktreeIdHint: record.worktreeId,
        tabIdHint: record.tabId
      })
      if (target) {
        return target
      }
    }
  }
  return null
}

// Why: resuming a session that a pane still owns starts a second process
// writing the same transcript. Focusing the live pane delivers what the user
// asked for — the session on screen — without the fork.
export function focusExistingAiVaultSessionPane(session: AiVaultSession): boolean {
  const existingPane = findLiveAiVaultSessionPane(useAppStore.getState(), session)
  if (!existingPane || !focusAiVaultOriginalPaneTarget(existingPane)) {
    return false
  }
  toast.success(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.agentSessionAlreadyRunning',
      '{{value0}} session is already running — focused its pane',
      { value0: agentLabel(session.agent) }
    )
  )
  return true
}
