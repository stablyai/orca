import { defineFixture } from '../../../component-fixtures/component-fixture'
import { CustomRelayServerSettings } from './CustomRelayServerSettings'

const settings = {
  enabled: true,
  authServerUrl: 'https://auth.example.com',
  clientId: 'orca-desktop',
  relayDirectorUrl: 'https://relay.example.com'
}

export const custom = defineFixture({
  width: 680,
  setup: () => {
    window.api.orcaProfiles.cloudServerSettings = async () => ({
      settings,
      allowLoopbackHttp: false,
      environmentOverrides: true
    })
    window.api.orcaProfiles.testCloudServer = async () => ({ auth: true, relay: false })
  },
  render: () => (
    <div className="p-4">
      <CustomRelayServerSettings />
    </div>
  )
})

export const narrow = defineFixture({
  ...custom,
  width: 360
})

export const tested = defineFixture({
  ...custom,
  interact: async (frame) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    Array.from(frame.querySelectorAll('button'))
      .find((button) => button.textContent === 'Test connection')
      ?.click()
  }
})

export const confirmation = defineFixture({
  ...custom,
  interact: async (frame) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    Array.from(frame.querySelectorAll('button'))
      .find((button) => button.textContent === 'Reset to default')
      ?.click()
  }
})
