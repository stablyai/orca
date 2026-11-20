import {
  Copy,
  ExternalLink,
  FileText,
  Globe,
  MessageSquarePlus,
  Quote,
  Search,
  Trash2,
  Undo2
} from 'lucide-react'
import {
  useNativeChatRewindConfirm,
  useNativeChatSlackMirrorContext
} from '../../slack-mirror/native-chat-slack-mirror'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { formatOptionalPrimaryShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useAppStore } from '@/store'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatContextMenuTarget } from './native-chat-context-menu-target'
import type { NativeChatSelectionReference } from '../../selection-quotes/native-chat-transcript-selection'
import type { NativeChatRewindSurface } from '../../messages/actions/use-native-chat-rewind-host'

function copyText(text: string): void {
  // Best-effort, as the row Copy buttons are: the clipboard can reject when unfocused.
  window.api.ui.writeClipboardText(text).catch(() => {})
}

/** The rows for what was right-clicked: each reuses the action its hover or click surface runs. */
export function NativeChatContextMenuTargetItems({
  target,
  onQuote,
  onAskInAuxiliaryChat,
  auxiliaryChatBlockedReason,
  rewind
}: {
  target: NativeChatContextMenuTarget
  onQuote: (text: string) => void
  onAskInAuxiliaryChat?: (reference: NativeChatSelectionReference) => void
  auxiliaryChatBlockedReason?: string | null
  rewind: NativeChatRewindSurface | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const {
    quoteText,
    auxiliaryReference,
    link,
    codeText,
    messageText,
    rewindItemId,
    slackPostedItemId
  } = target
  const slackMirror = useNativeChatSlackMirrorContext()
  const linkRows = link ? [link.primary, link.alternate, ...(link.secondaryActions ?? [])] : []
  return (
    <>
      {quoteText ? (
        <DropdownMenuItem onSelect={() => onQuote(quoteText)}>
          <Quote />
          {t('components.native-chat.addSelectionToChat', 'Add to chat')}
        </DropdownMenuItem>
      ) : null}
      {auxiliaryReference && onAskInAuxiliaryChat ? (
        <DropdownMenuItem
          disabled={Boolean(auxiliaryChatBlockedReason)}
          onSelect={() => onAskInAuxiliaryChat(auxiliaryReference)}
        >
          <MessageSquarePlus />
          <span className="grid min-w-0 flex-1">
            {t('components.native-chat.askSelectionInSideChat', 'Ask in auxiliary chat')}
            {auxiliaryChatBlockedReason ? (
              <span className="text-xs whitespace-normal text-muted-foreground contain-inline-size">
                {auxiliaryChatBlockedReason}
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
      ) : null}
      {linkRows.map((action) =>
        action ? (
          <DropdownMenuItem key={action.label} onSelect={() => void action.run()}>
            <LinkActionIcon action={action} />
            {action.label}
          </DropdownMenuItem>
        ) : null
      )}
      {link ? (
        <DropdownMenuItem onSelect={() => copyText(link.destination)}>
          <Copy />
          {link.kind === 'url'
            ? t('auto.components.terminal.pane.TerminalLinkActionPopover.copyLink', 'Copy link')
            : t('auto.components.activity.ActivityThreadContextMenu.copyPath', 'Copy Path')}
        </DropdownMenuItem>
      ) : null}
      {codeText ? (
        <DropdownMenuItem onSelect={() => copyText(codeText)}>
          <Copy />
          {t('components.native-chat.copyCode', 'Copy code')}
        </DropdownMenuItem>
      ) : null}
      {messageText ? (
        <DropdownMenuItem onSelect={() => copyText(messageText)}>
          <Copy />
          {t('components.native-chat.copyMessage.copy', 'Copy message')}
        </DropdownMenuItem>
      ) : null}
      {rewindItemId && rewind ? (
        <NativeChatRewindMenuItem itemId={rewindItemId} rewind={rewind} />
      ) : null}
      {slackPostedItemId && slackMirror ? (
        <DropdownMenuItem onSelect={() => void slackMirror.post(slackPostedItemId, 'delete')}>
          <Trash2 />
          {t('components.native-chat.slackMirror.delete', 'Delete from Slack')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

export function NativeChatFindMenuItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const t = useTranslate()
  const keybindings = useAppStore((state) => state.keybindings)
  const shortcut = formatOptionalPrimaryShortcutLabel('chat.find', keybindings)
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Search />
      {t('components.native-chat.find.label', 'Find in chat')}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/** The hover rewind button's action, disabled with its reason when the button would be. */
function NativeChatRewindMenuItem({
  itemId,
  rewind
}: {
  itemId: string
  rewind: NativeChatRewindSurface
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useNativeChatRewindConfirm()
  return (
    <DropdownMenuItem
      disabled={Boolean(rewind.disabledReason)}
      onSelect={() => void rewind.request(itemId, confirm)}
    >
      <Undo2 />
      <span className="grid min-w-0 flex-1">
        {t('components.native-chat.rewind.action', 'Rewind to here')}
        {/* A disabled row cannot show the button's tooltip, so its reason sits under the label,
            wrapping to the other rows' width (contain-inline-size) instead of widening the menu. */}
        {rewind.disabledReason ? (
          <span className="text-xs whitespace-normal text-muted-foreground contain-inline-size">
            {rewind.disabledReason}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  )
}

function LinkActionIcon({ action }: { action: LinkAction }): React.JSX.Element {
  if (action.external === true) {
    return <ExternalLink />
  }
  return action.external === false ? <Globe /> : <FileText />
}
