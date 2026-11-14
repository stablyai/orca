import { useSyncExternalStore } from 'react'
import {
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Quote,
  Search,
  Undo2,
  Volume2,
  VolumeX
} from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatContextMenuTarget } from './native-chat-context-menu-target'
import type { NativeChatRewindSurface } from '../../messages/actions/use-native-chat-rewind-host'
import {
  getNativeChatSpeechPreferences,
  subscribeNativeChatSpeechPreferences
} from '../../messages/actions/native-chat-speech-preferences'
import {
  getNativeChatSpeakingMessageId,
  subscribeNativeChatSpeech,
  toggleNativeChatMessageSpeech
} from '../../messages/actions/native-chat-speech-session'

function copyText(text: string): void {
  // Best-effort, as the row Copy buttons are: the clipboard can reject when unfocused.
  window.api.ui.writeClipboardText(text).catch(() => {})
}

/** The rows for what was right-clicked: each reuses the action its hover or click surface runs. */
export function NativeChatContextMenuTargetItems({
  target,
  onQuote,
  rewind
}: {
  target: NativeChatContextMenuTarget
  onQuote: (text: string) => void
  rewind: NativeChatRewindSurface | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const { quoteText, link, codeText, messageText, speakMessageId, rewindItemId } = target
  const linkRows = link ? [link.primary, link.alternate, ...(link.secondaryActions ?? [])] : []
  return (
    <>
      {quoteText ? (
        <DropdownMenuItem onSelect={() => onQuote(quoteText)}>
          <Quote />
          {t('components.native-chat.addSelectionToChat', 'Add to chat')}
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
      {speakMessageId && messageText ? (
        <NativeChatSpeakMenuItem messageId={speakMessageId} markdown={messageText} />
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

/** The hover Speak button's action, hidden when speech is turned off in Chat settings. */
function NativeChatSpeakMenuItem({
  messageId,
  markdown
}: {
  messageId: string
  markdown: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useSyncExternalStore(
    subscribeNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences
  )
  const speakingId = useSyncExternalStore(
    subscribeNativeChatSpeech,
    getNativeChatSpeakingMessageId,
    getNativeChatSpeakingMessageId
  )
  if (!settings.enabled) {
    return null
  }
  const speaking = speakingId === messageId
  const label = speaking
    ? t('components.native-chat.speakMessage.stop', 'Stop speaking')
    : t('components.native-chat.speakMessage.speak', 'Speak message')
  return (
    <DropdownMenuItem
      onSelect={() => toggleNativeChatMessageSpeech({ messageId, markdown, settings })}
    >
      {speaking ? <VolumeX /> : <Volume2 />}
      {label}
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
  const confirm = useConfirmationDialog()
  return (
    <DropdownMenuItem
      disabled={Boolean(rewind.disabledReason)}
      onSelect={() => void rewind.request(itemId, confirm)}
    >
      <Undo2 />
      <span className="grid min-w-0">
        {t('components.native-chat.rewind.action', 'Rewind to here')}
        {/* A disabled row cannot show the button's tooltip, so its reason sits under the label. */}
        {rewind.disabledReason ? (
          <span className="text-xs whitespace-normal text-muted-foreground">
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
