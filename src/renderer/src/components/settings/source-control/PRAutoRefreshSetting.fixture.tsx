import { useState } from 'react'
import type { PRAutoRefreshCadence } from '../../../../../shared/review-refresh-policy'
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

export const remoteReading = defineFixture({
  width,
  render: () => (
    <PRAutoRefreshControl cadence={null} onChange={() => {}} remoteHostName="Boston build server" />
  )
})
