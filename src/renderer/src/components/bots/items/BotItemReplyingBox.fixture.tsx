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
  'Will you re-pair the M4 Air now, or leave it unpaired until the relay update ships next week and pair it then?'
const LONG_ANSWER = [
  'Leave it unpaired for now.',
  'The relay update changes the pairing handshake, so pairing today would mean pairing twice.',
  'Once the update ships, pair it from Settings and run the smoke test on the remote worktree before handing it any reviews.',
  'If anything is urgent before then, route it to the local reviewer instead.'
].join('\n\n')

const asker = { kind: 'bot' as const, botId: fixtureCos.id, chatId: 'chat-home' }

function asking(uid: number, question: string): { item: BotItem; events: BotItemEvent[] } {
  const item = makeTestBotItem(uid, {
    title: 'Pair the M4 Air',
    owner: { botId: fixtureCos.id, name: 'Dev Ops' },
    status: 'needs_you',
    question: { eventId: `q${uid}`, text: question },
    createdAt: Date.now() - 3 * 3_600_000,
    updatedAt: Date.now() - 20 * 60_000,
    lastActivityAt: Date.now() - 20 * 60_000
  })
  const events: BotItemEvent[] = [
    { id: `m${uid}`, kind: 'made', actor: asker, data: {}, at: Date.now() - 3 * 3_600_000 },
    {
      id: `q${uid}`,
      kind: 'commented',
      actor: asker,
      data: { text: question },
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
  const bot = { ...fixtureCos, name: 'Dev Ops' }
  return (
    <div className="flex flex-col bg-sidebar" style={{ width, height }}>
      <BotItemPaneFrame walk={walk()} offline={false} onBack={() => {}} owner={bot}>
        {({ comment, nav }) => (
          <BotItemBody
            commentRef={comment}
            nav={nav}
            bot={bot}
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
  height: number
): ComponentFixture {
  const { item, events } = asking(uid, question)
  return defineFixture({
    // The frame's 16px padding each side, around a pane of exactly `width`.
    width: width + 32,
    // The bot's folder workspace, so the box offers Attach as on the item page.
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({
          id: fixtureCos.folderWorkspaceId,
          folderPath: '/home/me/.orca/bots/dev-ops'
        })
      ]
    },
    // Each theme's shot starts from the same draft.
    setup: () =>
      updateNativeChatComposerDraft(
        `bot-item-comment:${botRefKey(fixtureCos)}:${item.uid}`,
        { text: draft, images: [] },
        'immediate'
      ),
    render: () => <Pane item={item} events={events} width={width} height={height} />
  })
}

/** Nothing typed yet: about four lines of room, the tools on their own row below. */
export const empty360 = replying(401, SHORT_QUESTION, '', 360, 640)
export const empty700 = replying(402, SHORT_QUESTION, '', 700, 640)
/** A long answer: the box grows to its cap, then scrolls. */
export const longAnswer360 = replying(403, SHORT_QUESTION, LONG_ANSWER, 360, 640)
export const longAnswer700 = replying(404, SHORT_QUESTION, LONG_ANSWER, 700, 640)
/** A long question: the strip truncates it on its one line; the text keeps its room. */
export const longQuestion360 = replying(405, LONG_QUESTION, 'Leave it unpaired', 360, 640)
export const longQuestion700 = replying(406, LONG_QUESTION, 'Leave it unpaired', 700, 640)
/** A short, narrow pane: the box gives way so Activity and Send stay in view. */
export const shortPaneEmpty = replying(407, LONG_QUESTION, '', 220, 414)
export const shortPaneLongAnswer = replying(408, LONG_QUESTION, LONG_ANSWER, 220, 414)
