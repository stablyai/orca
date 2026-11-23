import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotPictureButton } from './BotPictureButton'
import { refreshAvatarCapability } from './avatar-generation-capability-store'
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
      <BotPictureButton bot={perf} picture={picture} avatarClassName="size-12 rounded-lg text-xl" />
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

function wearOutfit(name: string): () => Promise<void> {
  return async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Change picture"]')?.click()
    await settle(300)
    document.querySelector<HTMLButtonElement>('button[aria-label="Pink"]')?.click()
    document.querySelector<HTMLButtonElement>('button[aria-label="Outfit"]')?.click()
    await settle(300)
    document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)?.click()
    await settle(600)
  }
}

export const newOutfit = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBot />,
  interact: wearOutfit('Detective')
})

export const newReviewer = defineFixture({ ...newOutfit, interact: wearOutfit('Reviewer') })

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

async function artBase64(): Promise<string> {
  const bytes = new Uint8Array(await (await artPng()).arrayBuffer())
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** A local image agent that answers as `result` says, or never (still running). */
function stubGeneration(
  capability: AvatarGenerationCapability,
  result: 'image' | 'running' | 'usage-limit'
): () => void {
  return () => {
    stubUpload()
    const api: AvatarGenerationApi = {
      capability: async () => capability,
      generate: async () => {
        if (result === 'running') {
          return new Promise(() => {})
        }
        if (result === 'usage-limit') {
          return { ok: false, error: 'usage-limit', agent: 'codex' }
        }
        return {
          ok: true,
          agent: 'codex',
          image: { mimeType: 'image/png', base64: await artBase64() }
        }
      },
      cancel: async () => {}
    }
    Reflect.set(window.api, 'avatarGeneration', api)
    // The capability cache outlives a fixture, so it is read again from this stub.
    refreshAvatarCapability()
  }
}

function carousel(): HTMLElement {
  return document.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!
}

async function step(key: 'ArrowLeft' | 'ArrowRight'): Promise<void> {
  carousel().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  await settle(80)
}

/** The description field, once Generate is the current face and the field has folded open. */
function shownField(): HTMLTextAreaElement | null {
  const box = document.querySelector<HTMLTextAreaElement>('textarea')
  return box && !box.closest('[aria-hidden="true"]') ? box : null
}

// The Generate face sits just before mascot 1: step left until its description field shows.
async function openGenerate(frame: HTMLElement, description?: string): Promise<void> {
  await openPicture(frame)
  for (let tries = 0; tries < 25 && !shownField(); tries += 1) {
    await step('ArrowLeft')
  }
  // The rows cross-fade over 300 ms.
  await settle(400)
  if (description === undefined) {
    return
  }
  const box = shownField()!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    box,
    description
  )
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle(100)
  document.querySelector<HTMLButtonElement>('button[aria-label="Generate"]')?.click()
  await settle(600)
}

const READY: AvatarGenerationCapability = {
  agents: [
    { agent: 'codex', status: 'ready' },
    { agent: 'grok', status: 'ready' },
    { agent: 'antigravity', status: 'ready' }
  ]
}

export const generateIdle = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame)
})

export const generateRunning = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'running'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'a friendly orange fox astronaut')
})

export const generateResult = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'a friendly orange fox astronaut')
})

export const generateUsageLimit = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'usage-limit'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'a friendly orange fox astronaut')
})

export const generateRealPerson = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'me as a superhero')
})

export const generateSignedOut = defineFixture({
  width: 420,
  setup: stubGeneration({ agents: [{ agent: 'codex', status: 'signed-out' }] }, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame)
})

export const generateAgentPicker = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await openGenerateAgainBox()
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Generate with"]')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await settle()
  }
})

async function openGenerateAgainBox(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="Edit description"]')?.click()
  await settle(400)
}

export const generateEditing = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await openGenerateAgainBox()
  }
})

export const generateOneAgent = defineFixture({
  width: 420,
  setup: stubGeneration({ agents: [{ agent: 'codex', status: 'ready' }] }, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'a friendly orange fox astronaut')
})

export const generateBackToMascot = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await step('ArrowRight')
    await settle(400)
  }
})
