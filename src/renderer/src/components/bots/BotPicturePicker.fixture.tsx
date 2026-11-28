import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  dragOver,
  NewBot,
  NewBotFromSharedLink,
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
  stubGeneratorAfterRecheck,
  stubGeneratorChecking,
  stubSignedOutUntilRecheck,
  stubStaleProbe,
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

// No image agent on this computer: Generate stays, says so, and offers Check again.
export const generateNoAgent = defineFixture({
  width: 420,
  setup: stubUpload,
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, 'a tiny violet robot gardener', { submit: false })
})

export const generateChecking = defineFixture({
  width: 420,
  setup: stubGeneratorChecking,
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame)
})

// Driven by tests/component-fixtures: Check again finds Codex, then fail, retry, pick, cancel.
export const generateRecheckNewBot = defineFixture({
  width: 560,
  setup: stubGeneratorAfterRecheck,
  render: () => <NewBot />
})

export const generateRecheckSettings = defineFixture({
  width: 420,
  setup: stubGeneratorAfterRecheck,
  render: () => <Settings />
})

// New bot from a shared link with the bot's own picture, as reported: Generate is one step back.
export const generateSharedLinkNoAgent = defineFixture({
  width: 560,
  setup: stubUpload,
  render: () => <NewBotFromSharedLink />,
  interact: async () => {
    await settle(600)
    document.querySelector<HTMLButtonElement>('button[aria-label="Change picture"]')?.click()
    await settle(400)
  }
})

// The same with Codex ready: describing a new picture is in sight, not folded behind "Your image".
export const generateSharedLinkReady = defineFixture({
  ...generateSharedLinkNoAgent,
  setup: stubGeneration(READY, 'image')
})

// Codex signed out: the field says so with Check again, which finds it signed in.
export const generateSignedOutRecheck = defineFixture({
  width: 420,
  setup: stubSignedOutUntilRecheck,
  render: () => <Settings />
})

// A slow check started before a run found Codex signed out must not bring Generate back.
export const generateStaleProbe = defineFixture({
  width: 560,
  setup: stubStaleProbe,
  render: () => <NewBot />
})
