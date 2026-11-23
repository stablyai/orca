import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { mascotAvatar, PICKABLE_BOT_MASCOT_IDS } from '../../../../shared/bot-avatar'
import { BotPictureButton } from './BotPictureButton'
import { refreshAvatarCapability } from './avatar-generation-capability-store'
import type { BotPictureCustom, BotPictureValue } from './BotPicturePicker'

const bot: Bot = {
  id: 'perf',
  name: 'Perf Manager',
  hostId: 'local',
  folder: 'perf',
  folderWorkspaceId: 'fw-perf',
  agent: 'claude',
  avatar: 'mascot:D1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

// A 64 px warm gradient with a dark circle, saved as the bot's upload.
const UPLOAD_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAACh0lEQVR42tXZV27bUBCF4dlPkE1kO+m9995VXCRZkpsky06znd577z27OZm54IMDBPYdiry8A5wFfP+DIHJI+NPH7xn84vXwk9fFD14H3zv4Ni37OiX7Min7PIFPvHF85LXxgdfC+xbe8Zp4yxvDG14Drxt4VZe9rMlejMqej+AZbxhPeUN4wqvicRWPeBU85JXxgFfC/RLuXZTdvSC7c152+xxu8c7iJu8MbvBOk2k9rnOAZT0WJcCwHounyLQeCxJgWI+Fk2Raj3kJMKzH/Akyrcc1DrCsx9XjZFrvAizrceUYmda7AMt6XD5KpvUuwLIel46QaT3mJMCwHnOHKW/9qtVr8tNjVgIy1rN4+WWox+whykq/ovs/JQPr0ZeAYvRJw2B69A/SgPrU9H8y0uoxwwFF65OGVHr0JKB4fdKg16N3gCLRJw1KPboSEPRXu3KARo/ufopHnzRo9OhIQET6pMFbj84+0v7Xhgjw1mOaA7J+UsggwFuPqb0Umz5p8NO7AM0zZsAALz0m95DqCTlcgJ/eBWie7wMGeOkxsZu0byeBAvz0LiA+fdLgocf4LlK918amR1sCFG/l4QL89GjvJNVNIWCAlx4tCVBcRMIF+OnR2kGqe07AAC89mhKgu0ZFpUdzO2lvaSECvPUY4wDlJTBEgLceDQlQ3zHj0aOxjdJdYSPRoy4BaW7IOQZo9KhvpdQX8Bj0qElA+vt94XrUttCAXx+K1WOUA7L4+hDyV7tUj5HNlNW3k0L0LiDrLz/ZPiksr8fwJsrju9XSm4Lq7USrdwF56j3fa1PrMbSRTOtdgGU9qhvItB4VCTCsR2U9mdajLAGG9SivI9N6lCTAsB6ltX8BVudnY3qOuCwAAAAASUVORK5CYII='

const UPLOAD: BotPictureCustom = {
  src: `data:image/png;base64,${UPLOAD_PNG}`,
  fallback: '',
  after: 0,
  description: 'Your image',
  sentToSlack: true
}

// An emoji picture from before mascots, which Slack never gets.
const EMOJI: BotPictureCustom = { src: null, fallback: '🦊', after: 0, description: '🦊' }

function Picture({
  initial,
  custom = UPLOAD
}: {
  initial: BotPictureValue
  custom?: BotPictureCustom
}): React.JSX.Element {
  // The saved avatar matches the selection, as after it was applied.
  const shown: Bot = {
    ...bot,
    avatar:
      initial.kind === 'mascot'
        ? mascotAvatar(PICKABLE_BOT_MASCOT_IDS[initial.index])
        : custom.src
          ? 'upload:1'
          : custom.fallback
  }
  const [value, setValue] = useState(initial)
  const [color, setColor] = useState<string | null>(null)
  const picture: ReturnType<typeof useBotPictureSetting> = {
    value,
    custom,
    pick: setValue,
    upload: () => setValue({ kind: 'custom' }),
    undo: () => {},
    color,
    pickColor: setColor,
    outfit: null,
    pickOutfit: () => {}
  }
  return (
    <div className="flex h-[380px] items-start gap-4 p-6">
      <BotPictureButton
        bot={shown}
        picture={picture}
        avatarClassName="size-12 rounded-lg text-xl"
      />
      <div className="pt-3 text-lg font-semibold">{bot.name}</div>
    </div>
  )
}

// No image agents, whatever an earlier fixture in this page left, so the carousel has no Generate face.
function withoutGenerate(): void {
  Reflect.set(window.api, 'avatarGeneration', {
    capability: async () => ({ agents: [] }),
    generate: async () => ({ ok: false, error: 'unavailable' }),
    cancel: async () => {}
  })
  refreshAvatarCapability()
}

const openPicture = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLButtonElement>('button[aria-label="Edit bot picture"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

export const mascot = defineFixture({
  width: 420,
  setup: withoutGenerate,
  render: () => <Picture initial={{ kind: 'mascot', index: 0 }} />,
  interact: openPicture
})

export const uploaded = defineFixture({
  width: 420,
  // The button's own avatar reads the saved upload from the host.
  setup: () => {
    withoutGenerate()
    const runtime: unknown = window.api.runtime
    Reflect.set(window.api, 'runtime', {
      ...(typeof runtime === 'object' ? runtime : {}),
      call: async ({ method }: { method: string }) =>
        method === 'bots.avatar.read'
          ? { ok: true, result: { png: UPLOAD_PNG } }
          : { ok: false, error: { code: 'runtime_error', message: method } }
    })
  },
  render: () => <Picture initial={{ kind: 'custom' }} />,
  interact: openPicture
})

export const emoji = defineFixture({
  width: 420,
  setup: withoutGenerate,
  render: () => <Picture initial={{ kind: 'custom' }} custom={EMOJI} />,
  interact: openPicture
})
