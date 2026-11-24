import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CodexSharedServerFixDialog } from './CodexSharedServerFixDialog'

type Outcome = 'ok' | 'fail' | 'pending'

function settle(outcome: Outcome): () => Promise<boolean> {
  return () => (outcome === 'pending' ? new Promise(() => {}) : Promise.resolve(outcome === 'ok'))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  button?.click()
}

async function turnOff(alsoStop: boolean): Promise<void> {
  if (alsoStop) {
    document.querySelector<HTMLButtonElement>('button[role="checkbox"]')?.click()
    await nextFrame()
  }
  clickButton(alsoStop ? 'Turn off and stop server' : 'Turn off sharing')
  // Why wait: disable settles before the stop step starts.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function dialogFixture(
  api: { disable?: Outcome; stop?: Outcome } = {},
  interact?: () => Promise<void>
) {
  return defineFixture({
    width: 640,
    setup: () => {
      Object.assign(window.api.pty, {
        disableCodexSharedServerAutoStart: settle(api.disable ?? 'ok'),
        stopCodexSharedServer: settle(api.stop ?? 'ok')
      })
    },
    render: () => (
      <div className="h-[320px] bg-background">
        <CodexSharedServerFixDialog
          ptyId="pty-1"
          open
          onOpenChange={() => {}}
          onServerStopped={() => {}}
        />
      </div>
    ),
    interact
  })
}

export const idle = dialogFixture()

export const alsoStopChecked = dialogFixture({}, async () => {
  document.querySelector<HTMLButtonElement>('button[role="checkbox"]')?.click()
})

export const turningOff = dialogFixture({ disable: 'pending' }, () => turnOff(false))

export const disableFailed = dialogFixture({ disable: 'fail' }, () => turnOff(false))

export const stopping = dialogFixture({ stop: 'pending' }, () => turnOff(true))

export const stopFailedAfterOff = dialogFixture({ stop: 'fail' }, () => turnOff(true))
