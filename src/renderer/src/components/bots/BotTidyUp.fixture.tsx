import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { BotTidyUpView } from '../../../../shared/bots/bot-tidy-up'
import { BotTidyUpSection } from '../settings/bots/BotTidyUpSection'
import { BotTidyUpLine } from './BotTidyUpLine'
import { BotTidyUpReview } from './BotTidyUpReview'

const releaseManager: Bot = {
  id: 'bot-release',
  name: 'Release Manager',
  hostId: 'local',
  folder: 'release-manager',
  folderWorkspaceId: 'fw-release',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-release',
  createdAt: 1,
  updatedAt: 1
}

function todayAt(hour: number, minute: number): number {
  const at = new Date()
  at.setHours(hour, minute, 0, 0)
  return at.getTime()
}

const RUN: NonNullable<BotTidyUpView['last']> = {
  at: todayAt(3, 12),
  tookMs: 2 * 60_000,
  chats: 4,
  rowId: 'row-1',
  learned: ['Releases go out on Tuesdays'],
  replaced: ['Staging deploys go out on Fridays'],
  filed: [{ topic: 'release', count: 4 }],
  moved: 9,
  merged: 2,
  undone: false
}

const VIEW: BotTidyUpView = {
  setting: { on: true, every: 'night' },
  last: RUN,
  running: false,
  turnedOff: null,
  error: null
}

function stubTidyUp(view: BotTidyUpView): () => void {
  return () => {
    const runtime: unknown = window.api.runtime
    Reflect.set(window.api, 'runtime', {
      ...(typeof runtime === 'object' ? runtime : {}),
      call: async ({ method }: { method: string }) =>
        method === 'bots.tidyUp.get'
          ? { ok: true, result: { tidyUp: view } }
          : { ok: false, error: { code: 'runtime_error', message: method } }
    })
  }
}

const update = async (): Promise<Bot | null> => null

export const summary = defineFixture({
  width: 640,
  render: () => (
    <BotTidyUpReview
      run={RUN}
      open
      onOpenChange={() => {}}
      onUndo={() => {}}
      onOpenHistory={() => {}}
    />
  )
})

export const settings = defineFixture({
  width: 860,
  setup: stubTidyUp(VIEW),
  render: () => <BotTidyUpSection bot={releaseManager} update={update} />
})

export const turnedOff = defineFixture({
  width: 860,
  setup: stubTidyUp({
    ...VIEW,
    setting: { on: false, every: 'night' },
    turnedOff: "The last tidy-up didn't reply with a new MEMORY.md."
  }),
  render: () => (
    <BotTidyUpSection bot={{ ...releaseManager, tidyUp: { on: false } }} update={update} />
  )
})

export const homeLine = defineFixture({
  width: 640,
  render: () => <BotTidyUpLine note={{ botId: releaseManager.id, changes: 17 }} />
})

export const homeLineOneChange = defineFixture({
  width: 640,
  render: () => <BotTidyUpLine note={{ botId: releaseManager.id, changes: 1 }} />
})

export const homeLineFocused = defineFixture({
  width: 640,
  render: () => <BotTidyUpLine note={{ botId: releaseManager.id, changes: 2 }} />,
  interact: (frame) => frame.querySelector('button')?.focus()
})

/** Ten long learned facts and ten replaced ones: the summary scrolls inside the window. */
export const longSummary = defineFixture({
  width: 1280,
  render: () => (
    <BotTidyUpReview
      run={{
        ...RUN,
        learned: Array.from(
          { length: 10 },
          (_, i) =>
            `Release ${i + 1} goes out after the owner signs off the notes in #eng, never before the staging soak finishes`
        ),
        replaced: Array.from(
          { length: 10 },
          (_, i) => `Old staging rule ${i + 1}, from before the move`
        )
      }}
      open
      onOpenChange={() => {}}
      onUndo={() => {}}
      onOpenHistory={() => {}}
    />
  )
})
