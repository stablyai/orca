import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import { commitHistorySessionResume, waitForHistoryTerminalOpen } from './history-resume-receipts'
import type { AiVaultResumeStartup } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { activateAiVaultResumeWorkspace } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch'
import { notifyAiVaultSessionQueued } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-launch-feedback'
import '@/components/right-sidebar/ai-vault/session-list/ai-vault-session-filters'
import { agentLabel } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'

/** Resolves to the new terminal tab's id when this client created it, else null. */
export async function launchAiVaultSessionAndReveal(
  args: Parameters<typeof launchAiVaultSessionInNewTab>[0] &
    Pick<AiVaultResumeStartup, 'historyResume'>,
  describeFailure: (message: string) => string = (message) => message
): Promise<string | null> {
  const launch = launchAiVaultSessionInNewTab(args)
  let openedTabId = launch.tabId
  if (launch.tabId === null) {
    const outcome = await launch.runtimeLaunch
    if (outcome.status === 'failed') {
      toast.error(
        describeFailure(outcome.message) ||
          translate(
            'auto.lib.launch.agent.in.new.tab.11cce5cc77',
            'Could not launch {{value0}} in a new terminal.',
            { value0: agentLabel(args.agent) }
          )
      )
      throw new Error(outcome.message)
    }
    openedTabId = outcome.tabId ?? null
  }
  if (useAppStore.getState().activeWorktreeId !== args.worktreeId) {
    activateAiVaultResumeWorkspace(args.worktreeId)
  }
  notifyAiVaultSessionQueued(args.agent)
  if (args.historyResume) {
    if (!openedTabId) {
      throw new Error(
        'The resumed terminal could not be verified. Its History account has not been changed.'
      )
    }
    await waitForHistoryTerminalOpen(openedTabId)
    await commitHistorySessionResume(args.historyResume)
  }
  return openedTabId
}
