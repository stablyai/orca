import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useConversationSwitchReadiness, runCliChatResume } from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'

export function CliChatResumeMenuItems({
  tab,
  leadingSeparator,
  onComplete
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  leadingSeparator: boolean
  onComplete?: () => void
}): React.JSX.Element | null {
  const source = useAppStore(useShallow((state) => resolveCliChatResumeSource(state, { tab })))
  const confirm = useConfirmationDialog()
  const readiness = useConversationSwitchReadiness(
    source ? { direction: 'chat', ...source, source } : null
  )
  if (!source || source.hostUpdateRequired) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        switchLoading={!readiness.ready}
        switchExplanation={readiness.explanation}
        menuKind="context"
        tooltipSide="right"
        chatPending={readiness.pending}
        onResumeInNewChat={(event) => {
          event.preventDefault()
          void runCliChatResume(source, confirm).finally(() => onComplete?.())
        }}
      />
    </>
  )
}
