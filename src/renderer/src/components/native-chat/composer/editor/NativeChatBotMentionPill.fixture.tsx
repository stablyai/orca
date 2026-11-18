import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BotAvatarTile } from '../../../bots/BotAvatar'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import {
  NativeChatBotChatTitleContext,
  NativeChatMentionNamesContext
} from '../../native-chat-markdown-mentions'
import {
  NativeChatBotChatChooserContext,
  NativeChatBotChatPickerContext,
  NativeChatBotMentionTargetContext,
  type NativeChatBotMentionTarget
} from '../../native-chat-room-context'
import type { NativeChatBotChatPicker } from '../../native-chat-mention-chats'
import { NativeChatComposerNotices } from '../controls/NativeChatComposerNotices'
import { botMentionToken } from '../../../../../../shared/bots/bot-mention-context'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'

const NORA = { id: '52fbc8b4-69a9-4cf9-89ef-72499d00c3d7', name: 'Eng - Nora' }
const UX = { id: 'ux-designer', name: 'UX Designer' }
const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#6d5dfc"/><circle cx="8" cy="6.5" r="3" fill="#fff"/><rect x="3" y="11" width="10" height="4" rx="2" fill="#fff"/></svg>'
)}`

const LONG = { id: 'onboarding-ux', name: 'UX Designer for the onboarding and settings flows' }
const QA = { id: 'qa-nightly', name: 'QA Nightly' }
const tile = (src: string | null, fallback: string) => (
  <BotAvatarTile src={src} fallback={fallback} className="size-full rounded-sm text-3xs" />
)
// The bots on the chat's computer, as the bots room looks them up by id.
const LISTED = new Map<string, NativeChatBotMentionTarget>([
  [NORA.id, { name: NORA.name, avatar: tile(PICTURE, 'E'), paused: false }],
  [UX.id, { name: UX.name, avatar: tile(null, '🎨'), paused: false }],
  [LONG.id, { name: LONG.name, avatar: tile(null, '🧭'), paused: false }],
  [QA.id, { name: QA.name, avatar: tile(null, '🧪'), paused: true }]
])
const listed = (id: string) => LISTED.get(id) ?? null
const notListedYet = () => undefined

const DRAFT = `ask ${botMentionToken(NORA)} to review the change, then ${botMentionToken(UX)} for the copy`

function Composer({
  value,
  lookup = listed
}: {
  value: string
  lookup?: (id: string) => NativeChatBotMentionTarget | null | undefined
}): React.JSX.Element {
  const inputRef = useRef<NativeChatComposerInput>(null)
  return (
    <NativeChatBotMentionTargetContext.Provider value={lookup}>
      <div className="native-chat-appearance p-4">
        <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
          <NativeChatPromptEditor
            inputRef={inputRef}
            initialValue={value}
            disabled={false}
            placeholder="Ask anything, @ to mention bots or files, / for commands"
            onChange={() => {}}
            onSelect={() => {}}
            className="min-h-14 w-full bg-transparent px-2 py-1 text-sm text-foreground outline-none"
          />
        </div>
      </div>
    </NativeChatBotMentionTargetContext.Provider>
  )
}

/** The composer after picking bots under `@`: each shows as its picture and name. */
export const picked = defineFixture({
  width: 640,
  render: () => <Composer value={DRAFT} />
})

/** A long draft wraps with the pills inline; a long name truncates (its tooltip has it whole). */
export const narrow = defineFixture({
  width: 320,
  render: () => <Composer value={`${DRAFT}, and ${botMentionToken(LONG)}`} />
})

/** A deleted bot and a paused one show dimmed and dashed (the message won't reach them); a
 *  renamed one shows its new name. The live pills share the baseline. */
export const states = defineFixture({
  width: 640,
  render: () => (
    <Composer
      value={`ask ${botMentionToken({ id: 'gone', name: 'Old bot' })} or ${botMentionToken(QA)} or ${botMentionToken({ id: NORA.id, name: 'Nora (old name)' })} or ${botMentionToken(UX)}`}
    />
  )
})

/** Before the chat's computer has listed its bots, a pill shows the picked name and a bot icon. */
export const notListed = defineFixture({
  width: 640,
  render: () => (
    <Composer
      lookup={notListedYet}
      value={`ask ${botMentionToken({ id: 'gone', name: 'Old bot' })} or ${botMentionToken(UX)}`}
    />
  )
})

/** The same message once sent: the transcript shows each bot as its mention, not the link. */
export const sent = defineFixture({
  width: 640,
  render: () => (
    <NativeChatMentionNamesContext.Provider value={null}>
      <div className="native-chat-appearance p-4">
        <NativeChatMarkdown content={DRAFT} variant="document" />
      </div>
    </NativeChatMentionNamesContext.Provider>
  )
})

// A chat of a bot picked one level under it: the pill reads `Bot › Chat`, with ⌄ to change it.
const NOTES = 'Release notes perf section'
const LONG_TITLE = 'Why is the Windows terminal slow when a large repo with many submodules is open'
const chatPicker = (
  unavailable: string | null,
  open: NativeChatBotChatPicker['shown'] = null
): NativeChatBotChatPicker => ({
  offers: (id) => id !== QA.id,
  selfId: null,
  watch: () => {},
  prefetch: () => {},
  view: () => {},
  shown: open,
  retry: () => {},
  token: () => '',
  pick: () => (unavailable ? { state: 'unavailable', why: unavailable } : { state: 'ok' }),
  title: (_bot, chat) => (chat === 'long' ? LONG_TITLE : NOTES)
})

const CLOSED = { at: null, open: () => {}, close: () => {} }
const OPEN_FIRST = { ...CLOSED, at: 0 }
const notesTitle = (_bot: string, chat: string) => (chat === 'notes' ? NOTES : null)

function ChatComposer({
  value,
  picker,
  chooserAt = null,
  notice = null
}: {
  value: string
  picker: NativeChatBotChatPicker
  chooserAt?: 0 | null
  notice?: string | null
}): React.JSX.Element {
  return (
    <NativeChatBotChatPickerContext.Provider value={picker}>
      <NativeChatBotChatChooserContext.Provider value={chooserAt === null ? CLOSED : OPEN_FIRST}>
        <div className={chooserAt === null ? undefined : 'pt-72'}>
          {notice ? (
            <div className="px-4 pt-4">
              <NativeChatComposerNotices
                notices={[
                  {
                    key: 'chat',
                    kind: 'error',
                    text: notice,
                    action: { label: 'Choose chat', onClick: () => {} }
                  }
                ]}
              />
            </div>
          ) : null}
          <Composer value={value} />
        </div>
      </NativeChatBotChatChooserContext.Provider>
    </NativeChatBotChatPickerContext.Provider>
  )
}

/** 5. A picked chat: the bot, ›, the chat's title, and ⌄ Change chat. */
export const chatPicked = defineFixture({
  width: 640,
  render: () => (
    <ChatComposer
      picker={chatPicker(null)}
      value={`Ask ${botMentionToken(NORA, 'notes')} to add the 180 ms cold-start win`}
    />
  )
})

/** A long title is cut short; the bot's name, › and ⌄ always show. */
export const chatLongTitle = defineFixture({
  width: 420,
  render: () => (
    <ChatComposer
      picker={chatPicker(null)}
      value={`Ask ${botMentionToken(NORA, 'long')} to look again`}
    />
  )
})

/** The picked chat was closed: "Chat unavailable", the reason above with Choose chat; Send waits. */
export const chatUnavailable = defineFixture({
  width: 640,
  render: () => (
    <ChatComposer
      picker={chatPicker(`${NORA.name}'s chat "${NOTES}" was closed, so it can't take messages.`)}
      notice={`${NORA.name}'s chat "${NOTES}" was closed, so it can't take messages.`}
      value={`Ask ${botMentionToken(NORA, 'notes')} to add the 180 ms cold-start win`}
    />
  )
})

/** ⌄ opens the bot's chats at the pill, the current one checked. */
export const chatChooser = defineFixture({
  width: 640,
  render: () => (
    <ChatComposer
      chooserAt={0}
      picker={chatPicker(null, {
        botId: NORA.id,
        name: NORA.name,
        avatar: tile(PICTURE, 'E'),
        chats: {
          status: 'ready',
          chats: [
            {
              id: 'home',
              title: 'Home Chat',
              search: '',
              icon: null,
              line: 'Profiled cold start',
              time: '4m',
              plain: true
            },
            {
              id: 'notes',
              title: NOTES,
              search: '',
              icon: null,
              line: 'Drafted the perf part',
              time: '26m',
              plain: false
            },
            {
              id: 'relay',
              title: 'Relay reconnect audit',
              search: '',
              icon: null,
              line: 'Replying…',
              time: 'now',
              plain: false
            }
          ]
        }
      })}
      value={`Ask ${botMentionToken(NORA, 'notes')} to add the 180 ms cold-start win`}
    />
  )
})

/** The sent message: one chip, `@Bot › Chat`, the title looked up by id (else `chat 7f3c9a`). */
export const chatSent = defineFixture({
  width: 640,
  render: () => (
    <NativeChatBotChatTitleContext.Provider value={notesTitle}>
      <div className="native-chat-appearance space-y-2 p-4">
        <NativeChatMarkdown
          content={`Ask ${botMentionToken(NORA, 'notes')} to add the 180 ms cold-start win`}
          variant="document"
        />
        <NativeChatMentionNamesContext.Provider value={null}>
          <NativeChatMarkdown
            content={`Gone from the list: ${botMentionToken(NORA, '7f3c9a21-4b1e')}`}
            variant="document"
          />
        </NativeChatMentionNamesContext.Provider>
      </div>
    </NativeChatBotChatTitleContext.Provider>
  )
})
