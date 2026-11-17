import { createContext, useEffect, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createNativeChatHostOutageLatch } from './native-chat-host-outage-latch'

export const NativeChatHostOutageContext = createContext<ReturnType<
  typeof createNativeChatHostOutageLatch
> | null>(null)

export function NativeChatHostOutageOwner({
  target,
  children
}: {
  target: RuntimeClientTarget
  children: React.ReactNode
}) {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [latch] = useState(createNativeChatHostOutageLatch)
  useEffect(
    () => (environmentId === null ? undefined : latch.track(environmentId)),
    [environmentId, latch]
  )
  return <NativeChatHostOutageContext value={latch}>{children}</NativeChatHostOutageContext>
}
