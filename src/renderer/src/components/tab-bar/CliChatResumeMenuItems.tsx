import { useState } from 'react'
import { useAppStore } from '@/store'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
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
  const [source] = useState(() => resolveCliChatResumeSource(useAppStore.getState(), { tab }))
  const pending = useCliChatResumePending(source)
  // Radix disables pointer events on disabled items, so a tooltip-less "update" item would only confuse.
  if (!source || source.hostUpdateRequired) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="context"
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
