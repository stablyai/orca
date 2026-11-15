import { useState, type ReactNode } from 'react'
import {
  setPRAutoRefreshCadenceForHost,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { useHostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PRAutoRefreshControl } from './PRAutoRefreshControl'
import { SettingsGroup } from '../section-layout/SettingsGroup'

function Interactive({
  initial,
  remoteHostName
}: {
  initial: PRAutoRefreshCadence
  remoteHostName: string | null
}): React.JSX.Element {
  const [cadence, setCadence] = useState<PRAutoRefreshCadence>(initial)
  return (
    <PRAutoRefreshControl cadence={cadence} onChange={setCadence} remoteHostName={remoteHostName} />
  )
}

function Frame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="settings-view-shell p-5">
      <SettingsGroup title="Source Control">{children}</SettingsGroup>
    </div>
  )
}

const width = 760

export const localDefault = defineFixture({
  width,
  render: () => (
    <Frame>
      <Interactive initial="default" remoteHostName={null} />
    </Frame>
  )
})

export const localReduced = defineFixture({
  width,
  render: () => (
    <Frame>
      <Interactive initial="reduced" remoteHostName={null} />
    </Frame>
  )
})

export const localOff = defineFixture({
  width,
  render: () => (
    <Frame>
      <Interactive initial="off" remoteHostName={null} />
    </Frame>
  )
})

export const remoteMinimal = defineFixture({
  width,
  render: () => (
    <Frame>
      <Interactive initial="minimal" remoteHostName="dev-box" />
    </Frame>
  )
})

export const narrow = defineFixture({
  width: 360,
  render: () => (
    <Frame>
      <Interactive initial="reduced" remoteHostName={null} />
    </Frame>
  )
})

export const info = defineFixture({
  width,
  render: () => (
    <Frame>
      <Interactive initial="default" remoteHostName={null} />
    </Frame>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label="About PR Updates"]')?.focus()
  }
})

const EXTERNAL_CHANGE_HOST = 'fixture-boston'

/** The real subscribed path of the Settings row for a paired host: the control shows the one
 *  shared copy of that host's setting, not its own snapshot. */
function SubscribedRemote(): React.JSX.Element {
  const cadence = useHostPRAutoRefreshCadence(EXTERNAL_CHANGE_HOST)
  return (
    <PRAutoRefreshControl
      cadence={cadence}
      onChange={(next) => setPRAutoRefreshCadenceForHost(EXTERNAL_CHANGE_HOST, next)}
      remoteHostName="Boston build server"
    />
  )
}

/** Mounted showing Default; another client then sets the host to Off (what the host's
 *  `settingsChanged` read remembers), and the mounted control follows without a remount. */
export const remoteExternalChange = defineFixture({
  width,
  setup: () => setPRAutoRefreshCadenceForHost(EXTERNAL_CHANGE_HOST, 'default'),
  render: () => (
    <Frame>
      <SubscribedRemote />
    </Frame>
  ),
  interact: () => setPRAutoRefreshCadenceForHost(EXTERNAL_CHANGE_HOST, 'off')
})

export const remoteReading = defineFixture({
  width,
  render: () => (
    <Frame>
      <PRAutoRefreshControl cadence={null} onChange={() => {}} remoteHostName="dev-box" />
    </Frame>
  )
})

export const remoteOlderHost = defineFixture({
  width,
  render: () => (
    <Frame>
      <PRAutoRefreshControl
        cadence={null}
        unsupported
        onChange={() => {}}
        remoteHostName="dev-box"
      />
    </Frame>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[role="radio"]')?.focus()
  }
})
