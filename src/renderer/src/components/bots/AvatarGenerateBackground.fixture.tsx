// Avatar generation going on with the picker closed: the spinner veil and badge, a run that outlives
// its settings view, the picture applied on its own, and the failure said after leaving.
import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { BotAvatar } from './BotAvatar'
import {
  NewBot,
  openGenerate,
  openPicture,
  perf,
  READY,
  Settings,
  SettingsPicture,
  settle,
  shownField,
  step,
  stubGeneration
} from '../../component-fixtures/fixture-bot-picture'

// Settings that can be left mid-run: the bot's row stays, as the sidebar's does.
function LeavableSettings(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex h-[300px] flex-col gap-4 p-6">
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
        <BotAvatar bot={perf} className="size-5 rounded-[5px] text-[10px]" />
        {perf.name}
      </div>
      {open ? (
        <div className="flex items-center gap-4">
          <SettingsPicture />
          <button type="button" aria-label="Leave settings" onClick={() => setOpen(false)}>
            Back
          </button>
        </div>
      ) : null}
      <Toaster position="top-left" toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

const LONG_DESCRIPTION =
  'A friendly orange fox astronaut in a round glass helmet, floating past a ringed planet, with a ' +
  'tiny wrench in one paw, soft pastel stars behind, and a mission patch shaped like an acorn on its ' +
  'chest, drawn in a clean flat sticker style with a thick white outline'

/** Closes the picker as a click on its picture does; the run goes on. */
async function closePicture(frame: HTMLElement): Promise<void> {
  await openPicture(frame)
  await settle(400)
}

export const generateLongDescription = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'image'),
  render: () => <Settings />,
  interact: (frame) => openGenerate(frame, LONG_DESCRIPTION, { submit: false })
})

export const generateRunningClosed = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'running'),
  render: () => <Settings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await closePicture(frame)
  }
})

export const generateLeftMidRun = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'running'),
  render: () => <LeavableSettings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await closePicture(frame)
    frame.querySelector<HTMLButtonElement>('button[aria-label="Leave settings"]')?.click()
    await settle()
  }
})

export const generateFailedAfterLeaving = defineFixture({
  width: 420,
  setup: stubGeneration(READY, 'late-failure'),
  render: () => <LeavableSettings />,
  interact: async (frame) => {
    await openGenerate(frame, 'a friendly orange fox astronaut')
    await closePicture(frame)
    frame.querySelector<HTMLButtonElement>('button[aria-label="Leave settings"]')?.click()
    await settle(2500)
  }
})

/** New bot's picture button opens and closes its picker. */
async function toggleNewPicture(): Promise<void> {
  document
    .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Change picture"]')
    ?.click()
  await settle(400)
}

async function generateInNewBot(frame: HTMLElement, description?: string): Promise<void> {
  await toggleNewPicture()
  for (let tries = 0; tries < 25 && !shownField(); tries += 1) {
    await step('ArrowLeft')
  }
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
  void frame
}

async function submitGenerate(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="Generate"]')?.click()
  await settle(600)
}

export const newGenerateRunningClosed = defineFixture({
  width: 560,
  setup: stubGeneration(READY, 'running'),
  render: () => <NewBot />,
  interact: async (frame) => {
    await generateInNewBot(frame, 'a friendly orange fox astronaut')
    await submitGenerate()
    await toggleNewPicture()
  }
})

export const newGenerateApplied = defineFixture({
  width: 560,
  setup: stubGeneration(READY, 'late-image'),
  render: () => <NewBot />,
  interact: async (frame) => {
    await generateInNewBot(frame, 'a friendly orange fox astronaut')
    await submitGenerate()
    const trigger = document.querySelector<HTMLElement>(
      '[role="dialog"] button[aria-label="Change picture"]'
    )
    const before = trigger?.querySelector('img')?.src
    await toggleNewPicture()
    // The picture lands about a second later and is cropped first: wait until the badge's spinner has
    // gone and the picture shown is a new one, rather than a fixed time.
    for (let tries = 0; tries < 50; tries += 1) {
      const shown = trigger?.querySelector('img')?.src
      if (!trigger?.querySelector('.loading-spinner') && shown && shown !== before) {
        break
      }
      await settle(100)
    }
    await settle(300)
  }
})
