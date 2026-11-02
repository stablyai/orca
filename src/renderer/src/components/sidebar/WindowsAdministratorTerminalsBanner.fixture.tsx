import { defineFixture } from '../../component-fixtures/component-fixture'
import { WindowsAdministratorTerminalsBanner } from './WindowsAdministratorTerminalsBanner'

const SIDEBAR_WIDTH = 280

function installStandardTerminalHost(liveSessionCount: number | null): void {
  const platform = window.api.platform.get()
  window.api = {
    ...window.api,
    platform: { ...window.api.platform, get: () => ({ ...platform, platform: 'win32' }) },
    pty: {
      ...window.api.pty,
      management: {
        ...window.api.pty.management,
        windowsStandardTerminalHost: () =>
          Promise.resolve({ host: { pid: 4100, liveSessionCount } })
      }
    }
  }
}

export const banner = defineFixture({
  width: SIDEBAR_WIDTH,
  setup: () => installStandardTerminalHost(3),
  render: () => <WindowsAdministratorTerminalsBanner />
})

export const confirmRestart = defineFixture({
  width: SIDEBAR_WIDTH,
  setup: () => installStandardTerminalHost(3),
  render: () => <WindowsAdministratorTerminalsBanner />,
  interact: async (frame) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const restart = frame.querySelector<HTMLButtonElement>('section button')
      if (restart) {
        restart.click()
        return
      }
      await new Promise((settle) => setTimeout(settle, 25))
    }
  }
})
