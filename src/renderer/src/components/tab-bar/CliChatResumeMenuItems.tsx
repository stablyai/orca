import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import { resolveCliChatResumeSource, useCliChatResumeCapability } from './cli-chat-resume-source'
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
  const source = useAppStore(useShallow((state) => resolveCliChatResumeSource(state, { tab })))
  const capability = useCliChatResumeCapability(tab.worktreeId, source?.agent)
  const pending = useCliChatResumePending(source)
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!source || (!enabled && capability !== false)) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action={capability === false ? 'resume' : 'switch'}
        switchLoading={capability === undefined}
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
