import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles/orca-profiles'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { CustomCloudServerSettings } from '../../../../../shared/settings/custom-cloud-server'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

const ownServer: CustomCloudServerSettings = {
  enabled: true,
  authServerUrl: 'https://auth.example.com',
  clientId: 'orca-desktop',
  relayDirectorUrl: 'https://relay.example.com'
}
const orcaServer: CustomCloudServerSettings = {
  enabled: false,
  authServerUrl: 'https://login.onorca.dev',
  clientId: 'orca-desktop',
  relayDirectorUrl: 'https://relay.onorca.dev'
}

const signedIn: OrcaProfileAuthStatus = {
  activeProfileId: 'local',
  configured: true,
  state: 'connected',
  persistence: 'memory-only'
}
const signedOut: OrcaProfileAuthStatus = { ...signedIn, state: 'local' }

function stubServer(
  settings: CustomCloudServerSettings,
  auth: OrcaProfileAuthStatus,
  environmentOverrides = false
): () => void {
  return () => {
    window.api.orcaProfiles.cloudServerSettings = async () => ({
      settings,
      allowLoopbackHttp: false,
      environmentOverrides
    })
    window.api.orcaProfiles.authStatus = async () => auth
    window.api.orcaProfiles.testCloudServer = async () => ({ auth: true, relay: false })
    window.api.mobile.getRelayStatus = async () => ({
      status: 'registered',
      cellUrl: 'https://cell-1.relay.example.com'
    })
  }
}

function Connection({
  initial,
  compact
}: {
  initial: MobilePairingConnectionMode
  compact?: boolean
}): React.JSX.Element {
  const [mode, setMode] = useState(initial)
  return (
    <div className="p-4">
      <MobilePairingConnectionOptions value={mode} onChange={setMode} compact={compact} />
    </div>
  )
}

function click(frame: HTMLElement, match: (element: HTMLElement) => boolean): void {
  Array.from(frame.querySelectorAll<HTMLElement>('[role="radio"], button')).find(match)?.click()
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

export const orcaRelay = defineFixture({
  width: 560,
  store: { orcaProfileAuthStatus: signedIn },
  setup: stubServer(orcaServer, signedIn),
  render: () => <Connection initial="automatic" />
})

export const ownRelayDraft = defineFixture({
  ...orcaRelay,
  interact: async (frame) => {
    await nextFrame()
    click(frame, (el) => el.textContent?.startsWith('Your own relay') ?? false)
  }
})

export const ownRelayActive = defineFixture({
  width: 560,
  store: { orcaProfileAuthStatus: signedIn },
  setup: stubServer(ownServer, signedIn),
  render: () => <Connection initial="automatic" />
})

export const ownRelaySignInRequired = defineFixture({
  ...ownRelayActive,
  store: { orcaProfileAuthStatus: signedOut },
  setup: stubServer(ownServer, signedOut)
})

export const tested = defineFixture({
  ...ownRelayActive,
  interact: async (frame) => {
    await nextFrame()
    click(frame, (el) => el.textContent === 'Test connection')
  }
})

export const switchBackConfirmation = defineFixture({
  ...ownRelayActive,
  interact: async (frame) => {
    await nextFrame()
    click(
      frame,
      (el) =>
        el.getAttribute('role') === 'radio' && el.textContent?.startsWith('Orca Relay') === true
    )
  }
})

export const environmentOverride = defineFixture({
  width: 560,
  store: { orcaProfileAuthStatus: signedIn },
  setup: stubServer(ownServer, signedIn, true),
  render: () => <Connection initial="automatic" />,
  interact: async (frame) => {
    await nextFrame()
    click(frame, (el) => el.textContent?.startsWith('Your own relay') ?? false)
  }
})

export const lan = defineFixture({
  ...ownRelayActive,
  render: () => <Connection initial="local-only" />
})

export const compactOwnRelay = defineFixture({
  ...ownRelayActive,
  width: 380,
  render: () => <Connection initial="automatic" compact />
})

export const compactNotSetUp = defineFixture({
  ...orcaRelay,
  width: 380,
  render: () => <Connection initial="automatic" compact />
})
