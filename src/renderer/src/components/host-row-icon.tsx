import React from 'react'
import { Monitor, Server } from 'lucide-react'

import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'

/** The local machine isn't a server — a monitor glyph reads as "this computer". */
export function HostRowIcon({
  hostId,
  className
}: {
  hostId: ExecutionHostId
  className?: string
}): React.JSX.Element {
  const Icon = hostId === LOCAL_EXECUTION_HOST_ID ? Monitor : Server
  return <Icon className={className ?? 'size-3.5 shrink-0 text-muted-foreground'} />
}
