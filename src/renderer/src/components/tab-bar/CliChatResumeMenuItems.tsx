import { getAgentStatusState } from '@/store/agent-status'
import { useState } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import { runCliChatResume, useCliChatResumePending } from './cli-chat-resume-run'

export function CliChatResumeMenuItems({
  tab,
  leadingSeparator,
  onComplete
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  leadingSeparator: boolean
  onComplete?: () => void
}): React.JSX.Element | null {
  const [source] = useState(() => resolveCliChatResumeSource(getAgentStatusState(), { tab }))
  const pending = useCliChatResumePending(source)
  if (!source) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="dropdown"
        tooltipSide="right"
        chatPending={pending}
        onResumeInNewChat={(event) => {
          event.preventDefault()
          void runCliChatResume(source).finally(() => onComplete?.())
        }}
      />
    </>
  )
}
