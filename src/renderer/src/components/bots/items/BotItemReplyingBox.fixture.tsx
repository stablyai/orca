import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { BotItemBody } from './BotItemView'
import { BotItemPaneFrame } from './BotItemPane'
import type { BotItemWalkState } from './use-bot-item-walk'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'

// The comment box while it names the agent's waiting question ("Replying to"), with the item stepper
// in its tool row, as on the item page.

const SHORT_QUESTION = 'Should the share link expire after 7 days by default?'
const LONG_QUESTION =
  'Should the sample report cover both example quarters now, or only the latest one with a link to the older numbers?'
const LONG_ANSWER = [
  'Only the latest quarter for now.',
  'The older numbers are already in the archive, so repeating them would make the report twice as long.',
  'Add a short link to the archive at the end, and keep the summary table to one page.',
  'If a reader asks for the older numbers, send them the archive link.'
].join('\n\n')

const sampleBot = {
  ...fixtureCos,
  id: 'fixture-report-bot',
  name: 'Sample Bot',
  folder: 'sample-bot',
  folderWorkspaceId: 'fixture-report-workspace',
  avatar: null
}
const asker = {
  kind: 'bot' as const,
  botId: sampleBot.id,
  chatId: 'chat-home'
}

const EARLIER = [
  'Starting on the sample report outline now.',
  'The example data has two quarters, and the template only fits one per page.',
  'Splitting the summary table needs a second page in the template.',
  'Template updated; both quarters now fit on two pages.',
  'Before going further, one choice about the scope of the report.',
  'The sample report is ready for a final pass.'
]

function asking(
  uid: number,
  question: string,
  earlier: readonly string[] = []
): { item: BotItem; events: BotItemEvent[] } {
  const item = makeTestBotItem(uid, {
    title: 'Draft the sample report',
    owner: { botId: sampleBot.id, name: sampleBot.name },
    status: 'needs_you',
    question: { eventId: `q${uid}`, text: question },
    createdAt: Date.now() - 3 * 3_600_000,
    updatedAt: Date.now() - 20 * 60_000,
    lastActivityAt: Date.now() - 20 * 60_000
  })
  const options = (
    question === SHORT_QUESTION
      ? ['Expire after 7 days', 'Keep the link open']
      : ['Both quarters', 'Latest quarter only']
  ).map((label) => ({ label }))
  const events: BotItemEvent[] = [
    {
      id: `m${uid}`,
      kind: 'made',
      actor: asker,
      data: {},
      at: Date.now() - 3 * 3_600_000
    },
    ...earlier.map((text, index): BotItemEvent => ({
      id: `c${uid}-${index}`,
      kind: 'commented',
      actor: asker,
      data: { text },
      at: Date.now() - (2 * 3_600_000 - index * 60_000)
    })),
    {
      id: `q${uid}`,
      kind: 'commented',
      actor: asker,
      data: { text: question, ask: { questions: [{ prompt: question, options }] } },
      at: Date.now() - 20 * 60_000
    },
    {
      id: `s${uid}`,
      kind: 'status',
      actor: asker,
      data: { from: 'working', to: 'needs_you' },
      at: Date.now() - 20 * 60_000
    }
  ]
  return { item, events }
}

function walk(): BotItemWalkState {
  return {
    uid: 'shown',
    place: { index: 1, total: 29 },
    pending: false,
    failed: false,
    canStep: () => true,
    open: () => {},
    step: () => {},
    retry: () => {},
    markGone: () => {},
    close: () => null
  }
}

/** The item page as the panel frames it: Back row, the item, the comment box with Attach and the
 *  stepper, in a pane of exactly `width` x `height`. */
function Pane({
  item,
  events,
  width,
  height
}: {
  item: BotItem
  events: BotItemEvent[]
  width: number
  height: number
}): React.JSX.Element {
  return (
    <div className="flex flex-col bg-sidebar" style={{ width, height }}>
      <BotItemPaneFrame walk={walk()} offline={false} onBack={() => {}} owner={sampleBot}>
        {({ comment, statusSlot, nav }) => (
          <BotItemBody
            commentRef={comment}
            statusSlot={statusSlot}
            nav={nav}
            bot={sampleBot}
            item={item}
            view={{
              item,
              events,
              eventsRead: true,
              hasEarlier: false,
              failed: false,
              deleted: false,
              loadEarlier: () => {},
              retry: () => {}
            }}
          />
        )}
      </BotItemPaneFrame>
    </div>
  )
}

function replying(
  uid: number,
  question: string,
  draft: string,
  width: number,
  height: number,
  earlier: readonly string[] = []
): ComponentFixture {
  const { item, events } = asking(uid, question, earlier)
  return defineFixture({
    // The frame's 16px padding each side, around a pane of exactly `width`.
    width: width + 32,
    // The bot's folder workspace, so the box offers Attach as on the item page.
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({
          id: sampleBot.folderWorkspaceId,
          folderPath: '/home/me/.orca/bots/sample-bot'
        })
      ]
    },
    // Each theme's shot starts from the same draft.
    setup: () =>
      updateNativeChatComposerDraft(
        `bot-item-comment:${botRefKey(sampleBot)}:${item.uid}`,
        { text: draft, images: [] },
        'immediate'
      ),
    render: () => <Pane item={item} events={events} width={width} height={height} />
  })
}

/** An idle reply with only the question chip, textbox and send control. */
export const empty360 = replying(401, SHORT_QUESTION, '', 360, 640)
export const empty700 = replying(402, SHORT_QUESTION, '', 700, 640)
/** A long answer: the box grows to its cap, then scrolls. */
export const longAnswer360 = replying(403, SHORT_QUESTION, LONG_ANSWER, 360, 640)
export const longAnswer700 = replying(404, SHORT_QUESTION, LONG_ANSWER, 700, 640)
/** A long question: the strip truncates it on its one line; the text keeps its room. */
export const longQuestion360 = replying(405, LONG_QUESTION, 'Only the latest quarter', 360, 640)
export const longQuestion700 = replying(406, LONG_QUESTION, 'Only the latest quarter', 700, 640)
/** A short, narrow pane: the box gives way so Activity and Send stay in view. */
export const shortPaneEmpty = replying(407, LONG_QUESTION, '', 220, 414)
export const shortPaneLongAnswer = replying(408, LONG_QUESTION, LONG_ANSWER, 220, 414)

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The "Replying to" mark's question button. */
function chip(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>('button[aria-label^="Replying to"]')
}

/** Read back to the top of a long Activity, with a draft in the box. */
async function readBack(frame: HTMLElement): Promise<void> {
  await pause(300)
  const scroller = frame.querySelector<HTMLElement>('.overflow-y-auto')
  scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, bubbles: true }))
  if (scroller) {
    scroller.scrollTop = 0
  }
  await pause(200)
  frame.querySelector<HTMLElement>('[contenteditable]')?.focus()
}

function longActivity(uid: number, width: number): ComponentFixture {
  return replying(uid, LONG_QUESTION, 'Only the latest quarter', width, 520, EARLIER)
}

/** A long Activity read back to its top: the question is out of view. */
export const readBack360 = { ...longActivity(411, 360), interact: readBack }
export const readBack700 = { ...longActivity(412, 700), interact: readBack }
/** Clicking "Replying to" scrolls to the question; its card's brief highlight can end before the shot. */
export const shownQuestion360 = {
  ...longActivity(413, 360),
  interact: async (frame: HTMLElement) => {
    await readBack(frame)
    chip(frame)?.click()
    await pause(300)
  }
}
export const shownQuestion700 = {
  ...longActivity(414, 700),
  interact: shownQuestion360.interact
}
/** Hovering "Replying to": its tooltip. */
export const chipTooltip360 = {
  ...longActivity(415, 360),
  interact: async (frame: HTMLElement) => {
    await readBack(frame)
    chip(frame)?.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
    )
    await pause(900)
  }
}
export const chipTooltip700 = {
  ...longActivity(416, 700),
  interact: chipTooltip360.interact
}
/** Its × hides the mark, with no scroll: the Activity stays where it was read. */
export const hidden360 = {
  ...longActivity(417, 360),
  interact: async (frame: HTMLElement) => {
    await readBack(frame)
    frame.querySelector<HTMLElement>('button[aria-label="Hide"]')?.click()
    await pause(400)
  }
}
export const hidden700 = {
  ...longActivity(418, 700),
  interact: hidden360.interact
}

// Idle and empty, the box is one compact row; focus opens it, and it folds back only when focus leaves it empty.

function plain(uid: number, draft: string, width: number): ComponentFixture {
  const { item, events } = asking(uid, SHORT_QUESTION, EARLIER)
  const quiet = { ...item, status: 'working' as const, question: null }
  const quietEvents = events.filter(
    (event) => event.kind !== 'status' && event.id !== item.question?.eventId
  )
  return {
    ...replying(uid, SHORT_QUESTION, draft, width, 520, EARLIER),
    render: () => <Pane item={quiet} events={quietEvents} width={width} height={520} />
  }
}

function editor(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>('[contenteditable]')
}

const focusBox = async (frame: HTMLElement): Promise<void> => {
  await pause(200)
  editor(frame)?.focus()
  await pause(300)
}
/** Focus in, then out to the Back row. */
const focusThenLeave = async (frame: HTMLElement): Promise<void> => {
  await focusBox(frame)
  frame.querySelector<HTMLElement>('button')?.focus()
  await pause(400)
}

export const compactIdle360 = plain(421, '', 360)
export const compactIdle700 = plain(422, '', 700)
export const compactFocused360 = { ...plain(423, '', 360), interact: focusBox }
export const compactFocused700 = { ...plain(424, '', 700), interact: focusBox }
export const compactTyping360 = {
  ...plain(425, 'Only the latest quarter', 360),
  interact: focusBox
}
export const compactTyping700 = {
  ...plain(426, 'Only the latest quarter', 700),
  interact: focusBox
}
/** A draft keeps it open after focus leaves. */
export const compactDraftBlurred360 = {
  ...plain(427, 'Only the latest quarter', 360),
  interact: focusThenLeave
}
export const compactDraftBlurred700 = {
  ...plain(428, 'Only the latest quarter', 700),
  interact: focusThenLeave
}
/** Empty when focus leaves: it folds back. */
export const compactEmptyBlurred360 = {
  ...plain(429, '', 360),
  interact: focusThenLeave
}
export const compactEmptyBlurred700 = {
  ...plain(430, '', 700),
  interact: focusThenLeave
}
/** "Replying to" stays above the compact row. */
export const compactReplying360 = longActivityEmpty(431, 360)
export const compactReplying700 = longActivityEmpty(432, 700)
export const compactReplyingFocused360 = {
  ...longActivityEmpty(433, 360),
  interact: focusBox
}
export const compactReplyingFocused700 = {
  ...longActivityEmpty(434, 700),
  interact: focusBox
}

function longActivityEmpty(uid: number, width: number): ComponentFixture {
  return replying(uid, LONG_QUESTION, '', width, 520, EARLIER)
}

/** Read partway up Activity, then the box opens: the messages in view stay where they were. */
async function readPartway(frame: HTMLElement): Promise<void> {
  await pause(300)
  const scroller = frame.querySelector<HTMLElement>('.overflow-y-auto')
  scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
  if (scroller) {
    scroller.scrollTop = 120
  }
  await pause(300)
}
export const scrolledIdle360 = { ...plain(435, '', 360), interact: readPartway }
export const scrolledFocused360 = {
  ...plain(436, '', 360),
  interact: async (frame: HTMLElement) => {
    await readPartway(frame)
    editor(frame)?.focus()
    await pause(400)
  }
}
