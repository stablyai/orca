import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { TerminalWindowsAdministratorSection } from './TerminalWindowsAdministratorSection'

function clickButton(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  button?.click()
}

export const restartConfirm = defineFixture({
  width: 640,
  setup: () => {
    Object.assign(window.api.app, {
      getWindowsAdministratorStatus: () => Promise.resolve(false),
      getIdentity: () => Promise.resolve({ isDev: false })
    })
  },
  render: () => (
    <div className="h-[360px] bg-background p-4">
      <TerminalWindowsAdministratorSection />
    </div>
  ),
  // Why wait: the trigger only offers restart once the status and identity probes settle.
  interact: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    clickButton('Restart as administrator')
  }
})
