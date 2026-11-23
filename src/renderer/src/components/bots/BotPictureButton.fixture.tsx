import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotPictureButton } from './BotPictureButton'
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

const UPLOAD: BotPictureCustom = {
  src: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#ffd8a8"/><stop offset="1" stop-color="#ff8f6b"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="36" r="18" fill="#2b2d42"/></svg>'
  )}`,
  fallback: '',
  after: 0,
  description: 'Your image'
}

function Picture({ initial }: { initial: BotPictureValue }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [color, setColor] = useState<string | null>(null)
  const picture: ReturnType<typeof useBotPictureSetting> = {
    value,
    custom: UPLOAD,
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
      <BotPictureButton bot={bot} picture={picture} avatarClassName="size-12 rounded-lg text-xl" />
      <div className="pt-3 text-lg font-semibold">{bot.name}</div>
    </div>
  )
}

const openPicture = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLButtonElement>('button[aria-label="Edit bot picture"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

export const mascot = defineFixture({
  width: 420,
  render: () => <Picture initial={{ kind: 'mascot', index: 0 }} />,
  interact: openPicture
})

export const uploaded = defineFixture({
  width: 420,
  render: () => <Picture initial={{ kind: 'custom' }} />,
  interact: openPicture
})
