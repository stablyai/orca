import { useState } from 'react'
import {
  setPRAutoRefreshCadenceForHost,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { useHostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PRAutoRefreshControl } from './PRAutoRefreshControl'

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

const width = 760

/** Settings host is this device: no scope note, the hint shows today's cadence. */
export const localDefault = defineFixture({
  width,
  render: () => <Interactive initial="default" remoteHostName={null} />
})

export const localReduced = defineFixture({
  width,
  render: () => <Interactive initial="reduced" remoteHostName={null} />
})

export const localOff = defineFixture({
  width,
  render: () => <Interactive initial="off" remoteHostName={null} />
})

/** A paired server is selected at the top of Settings: the control says whose timers change. */
export const remoteMinimal = defineFixture({
  width,
  render: () => <Interactive initial="minimal" remoteHostName="Boston build server" />
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
  render: () => <SubscribedRemote />,
  interact: () => setPRAutoRefreshCadenceForHost(EXTERNAL_CHANGE_HOST, 'off')
})

export const remoteReading = defineFixture({
  width,
  render: () => (
    <PRAutoRefreshControl cadence={null} onChange={() => {}} remoteHostName="Boston build server" />
  )
})
