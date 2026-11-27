import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  dragOver,
  NewBot,
  openGenerate,
  openGenerateAgainBox,
  openPicture,
  paste,
  artPng,
  READY,
  Settings,
  settle,
  step,
  stubGeneration,
  stubUpload
} from '../../component-fixtures/fixture-bot-picture'

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

export const generateNoImage = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'no-image'),
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
