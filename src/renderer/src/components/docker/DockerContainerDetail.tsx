import React from 'react'
import type { DockerContainerSummary } from '../../../../shared/docker-types'

export function DockerContainerDetail({
  container
}: {
  container: DockerContainerSummary | null
}): React.JSX.Element {
  if (!container) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a container to see its details.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{container.names[0] ?? container.id.slice(0, 12)}</span>
        <span className="font-mono text-xs text-muted-foreground">{container.image}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">State</dt>
        <dd>{container.state}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{container.status}</dd>
        <dt className="text-muted-foreground">ID</dt>
        <dd className="font-mono">{container.id.slice(0, 12)}</dd>
        {container.composeProject ? (
          <>
            <dt className="text-muted-foreground">Compose</dt>
            <dd>{container.composeProject}</dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}
