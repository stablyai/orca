import { makePaneKey } from '../../../../shared/stable-pane-id'
import { WslDistroStoppedCard } from './WslDistroStoppedCard'
import {
  startHeldPanesForWslDistro,
  useWslDistroStoppedHold
} from './wsl-distro-stopped-hold-state'

/** On a restored WSL bridge pane held because its distro is stopped: Start reconnects every such pane. */
export function WslDistroStoppedHoldCard({
  tabId,
  leafId
}: {
  tabId: string
  leafId: string
}): React.JSX.Element | null {
  const hold = useWslDistroStoppedHold(makePaneKey(tabId, leafId))
  if (!hold) {
    return null
  }
  return (
    <WslDistroStoppedCard
      distro={hold.distro}
      unverifiable={hold.state === 'unverifiable'}
      data={{
        'data-terminal-wsl-distro-stopped-hold': hold.distro,
        'data-terminal-wsl-distro-hold-state': hold.state
      }}
      onStart={() => startHeldPanesForWslDistro(hold.distro)}
    />
  )
}
