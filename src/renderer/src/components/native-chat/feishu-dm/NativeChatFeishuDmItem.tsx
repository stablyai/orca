// The composer under-row's Feishu note for a chat linked to the owner's Feishu DM. Feishu replies go
// only to the DM's own messages, so what the owner types here stays in Orca (Slack's mirror is off).
import { FeishuIcon } from '@/components/icons/FeishuIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'

const FOOTER_TEXT =
  'min-w-0 overflow-x-clip text-ellipsis text-2xs whitespace-nowrap [text-box:trim-both_cap_alphabetic]'

export function NativeChatFeishuDmItem({
  sessionId
}: {
  sessionId: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  // A bot's home folder workspace holds its conversation links; a session id names one chat.
  const linked = useAppStore(
    (state) =>
      sessionId !== undefined &&
      selectFolderWorkspaces(state).some((workspace) =>
        workspace.externalConversations?.some(
          (entry) => entry.sessionId === sessionId && entry.source === 'feishu-local'
        )
      )
  )
  if (!linked) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="flex h-5.5 min-w-0 max-w-64 shrink items-center gap-1 rounded-md px-1.5 text-chat-foreground-faint outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <FeishuIcon className="size-3 shrink-0 opacity-60 grayscale" aria-hidden />
          <span className={FOOTER_TEXT}>
            {t('components.native-chat.feishuDm.only', 'Only in Orca')}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-64">
        {t(
          'components.native-chat.feishuDm.tooltip',
          'Your Feishu DM gets replies to what you send there. What you type here stays in Orca.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
