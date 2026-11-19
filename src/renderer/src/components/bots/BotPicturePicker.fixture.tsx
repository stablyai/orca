import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotAvatar } from './BotAvatar'
import { BOT_PICTURE_DROP_OUTLINE, BotPicturePicker } from './BotPicturePicker'
import { NewBotDialog } from './NewBotDialog'

const perf: Bot = {
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

// Original art drawn here: a cat face on a warm gradient, `size` px square.
async function artPng(size = 512): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const c = canvas.getContext('2d')!
  const s = size / 512
  const g = c.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, '#ffd8a8')
  g.addColorStop(1, '#ff8f6b')
  c.fillStyle = g
  c.fillRect(0, 0, size, size)
  c.fillStyle = '#2b2d42'
  c.beginPath()
  c.arc(256 * s, 300 * s, 150 * s, 0, Math.PI * 2)
  c.moveTo(140 * s, 210 * s)
  c.lineTo(170 * s, 90 * s)
  c.lineTo(230 * s, 170 * s)
  c.moveTo(372 * s, 210 * s)
  c.lineTo(342 * s, 90 * s)
  c.lineTo(282 * s, 170 * s)
  c.fill()
  c.fillStyle = '#fff'
  for (const x of [205, 307]) {
    c.beginPath()
    c.arc(x * s, 290 * s, 26 * s, 0, Math.PI * 2)
    c.fill()
  }
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
  return new File([blob], 'cat.png', { type: 'image/png' })
}

/** Answers uploads without a runtime. */
function stubUpload(): void {
  stubBots([perf])
  const runtime = window.api.runtime
  const call = runtime.call
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: Parameters<typeof call>[0]) => {
      if (request.method === 'bots.avatar.upload') {
        return { ok: true, result: { bot: { ...perf, avatar: 'upload:fixture' } } }
      }
      return call(request)
    }
  })
}

const settle = (ms = 350): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

async function paste(file: File): Promise<void> {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  dialog().dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
  )
  await settle()
}

async function dragOver(): Promise<void> {
  const transfer = new DataTransfer()
  transfer.items.add(new File(['x'], 'cat.png', { type: 'image/png' }))
  dialog().dispatchEvent(
    new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true })
  )
  await settle()
}

function NewBot(): React.JSX.Element {
  return (
    <div className="h-[640px]">
      <NewBotDialog
        open
        onOpenChange={() => {}}
        initialName="Perf Manager"
        proposal={{ name: 'Perf Manager', purpose: '', mascot: 'D1' }}
      />
    </div>
  )
}

// Settings > Picture as BotGeneralSection draws it (that section's imports don't load in fixtures).
function Settings(): React.JSX.Element {
  const picture = useBotPictureSetting(perf, async () => perf)
  return (
    <div className="flex h-[380px] items-start gap-4 p-6">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="shrink-0 rounded-lg" aria-label="Edit bot picture">
            <BotAvatar bot={perf} className="size-12 rounded-lg text-xl" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className={BOT_PICTURE_DROP_OUTLINE}>
            <BotPicturePicker
              value={picture.value}
              custom={picture.custom}
              onChange={picture.pick}
              onUpload={picture.upload}
              onUndo={picture.undo}
              color={picture.color}
              onColorChange={picture.pickColor}
            />
            <p className="text-center text-xs text-muted-foreground">
              Changes your bot&apos;s picture in Slack too.
            </p>
          </div>
        </PopoverContent>
      </Popover>
      <div className="pt-3 text-lg font-semibold">{perf.name}</div>
    </div>
  )
}

const openPicture = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLButtonElement>('button[aria-label="Edit bot picture"]')?.click()
  await settle()
}

export const newIdle = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: async () => {
    document
      .querySelector<HTMLButtonElement>(
        '[role="dialog"] button.h-6, [role="dialog"] button[data-size="xs"]'
      )
      ?.focus()
    await settle(600)
  }
})

export const newColor = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: async () => {
    document
      .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Graphite"]')
      ?.click()
    await settle(600)
  }
})

export const newDrag = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: dragOver
})

export const newPasted = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: async () => paste(await artPng())
})

export const errorTooBig = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: () =>
    paste(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))
})
export const errorType = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: () => paste(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
})
export const errorSmall = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: async () => paste(await artPng(64))
})

export const settingsIdle = defineFixture({
  width: 420,
  setup: stubUpload,
  render: () => <Settings />,
  interact: openPicture
})

export const settingsDrag = defineFixture({
  width: 420,
  setup: stubUpload,
  render: () => <Settings />,
  interact: async (frame) => {
    await openPicture(frame)
    await dragOver()
  }
})

export const settingsSaved = defineFixture({
  width: 420,
  setup: stubUpload,
  render: () => <Settings />,
  interact: async (frame) => {
    await openPicture(frame)
    await paste(await artPng())
  }
})

export const settingsError = defineFixture({
  width: 420,
  setup: stubUpload,
  render: () => <Settings />,
  interact: async (frame) => {
    await openPicture(frame)
    await paste(await artPng(64))
  }
})
