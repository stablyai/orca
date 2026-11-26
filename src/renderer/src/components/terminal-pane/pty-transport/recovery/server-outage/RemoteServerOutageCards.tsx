import { useRemoteServerOutageIds } from './remote-server-notice-claims'
import { RemoteServerOutageCard } from './RemoteServerOutageCard'

/** Centers the window's server cards over the workspace and stacks them. */
export function RemoteServerOutageCardStack({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 px-3"
      data-remote-server-outage-cards=""
    >
      {children}
    </div>
  )
}

/** The window's down servers, one card each. */
export function RemoteServerOutageCards(): React.JSX.Element | null {
  const environmentIds = useRemoteServerOutageIds()
  if (environmentIds.length === 0) {
    return null
  }
  return (
    <RemoteServerOutageCardStack>
      {environmentIds.map((environmentId) => (
        <RemoteServerOutageCard key={environmentId} environmentId={environmentId} />
      ))}
    </RemoteServerOutageCardStack>
  )
}
