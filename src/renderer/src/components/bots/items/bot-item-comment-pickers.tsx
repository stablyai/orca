// The comment box's `@` and `/` lists: chat's own pickers, read as the item's bot's chat reads them.
import {
  useCallback,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction
} from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import type { NativeChatPickerItem } from '../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { SlashCommandSuggestion } from '../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatComposerNotice } from '../../native-chat/composer/controls/native-chat-composer-notice'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'
import { useNativeChatPickerState } from '../../native-chat/composer/pickers/use-native-chat-picker-state'
import {
  useNativeChatComposerMentions,
  useNativeChatMentionNameMatches
} from '../../native-chat/native-chat-composer-room'
import { BotWorkspaceChatRoom } from '../use-bot-chat-composer-room'

// A comment reaches the chat as mail, so commands that act on a chat's own session are not offered.
const NO_COMMANDS: readonly SlashCommandSuggestion[] = []

/** The `@` room of the item's bot's chats: its bots, and its own bot's other chats, as in that chat. */
export function BotItemCommentRoom({
  bot,
  children
}: {
  bot: Bot
  children: ReactNode
}): React.JSX.Element {
  return (
    <BotWorkspaceChatRoom workspaceId={bot.folderWorkspaceId} hostId={bot.hostId} sessionId={null}>
      {children}
    </BotWorkspaceChatRoom>
  )
}

/** `@` lists the bots and the bot folder's files, `/` the folder's skills. */
export function useBotItemCommentPickers(args: {
  bot: Bot
  scopeKey: string
  worktreeId: string | undefined
  draft: string
  caret: number
  notices: readonly NativeChatComposerNotice[]
  isComposing: () => boolean
  input: RefObject<NativeChatComposerInput | null>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}) {
  const { bot, scopeKey, worktreeId, draft, caret, notices, input, ...editor } = args
  const picker = useNativeChatPickerState({
    agent: bot.agent,
    terminalTabId: scopeKey,
    launchWorktreeId: worktreeId,
    mentionNameMatches: useNativeChatMentionNameMatches(undefined),
    draftScopeKey: scopeKey,
    draft,
    caret,
    agentCommands: NO_COMMANDS,
    recalledFromHistory: false,
    disabled: false,
    textareaRef: input,
    ...editor
  })
  const mentions = useNativeChatComposerMentions(undefined, draft, picker, {
    terminalTabId: scopeKey,
    structuredWorktreeId: worktreeId,
    caret,
    notices
  })
  // A scanned skill names no file chat would send; the comment's mail names the one it was found at.
  const { completeItem } = picker
  const completeWithFile = useCallback(
    (item: NativeChatPickerItem) =>
      completeItem(
        item.kind === 'skill' && !item.path && item.sources[0]
          ? { ...item, path: item.sources[0].skillFilePath }
          : item
      ),
    [completeItem]
  )
  return { picker: { ...picker, completeItem: completeWithFile }, mentions }
}
