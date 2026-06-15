import React, { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LOCAL_DOCKER_CONNECTION_ID } from '../../../../shared/docker-types'
import { DockerResourceTree } from './DockerResourceTree'
import { DockerContainerDetail } from './DockerContainerDetail'

export default function DockerPage(): React.JSX.Element {
  const {
    activeConnectionId,
    containersByConnection,
    selectedContainerId,
    dockerConnectionError,
    setActiveDockerConnection,
    refreshDockerContainers,
    selectDockerContainer
  } = useAppStore(
    useShallow((s) => ({
      activeConnectionId: s.activeConnectionId,
      containersByConnection: s.containersByConnection,
      selectedContainerId: s.selectedContainerId,
      dockerConnectionError: s.dockerConnectionError,
      setActiveDockerConnection: s.setActiveDockerConnection,
      refreshDockerContainers: s.refreshDockerContainers,
      selectDockerContainer: s.selectDockerContainer
    }))
  )

  // Connect to the local daemon on first open.
  useEffect(() => {
    void setActiveDockerConnection(LOCAL_DOCKER_CONNECTION_ID)
  }, [setActiveDockerConnection])

  const containers = containersByConnection[activeConnectionId] ?? []
  const selected = containers.find((c) => c.id === selectedContainerId) ?? null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Docker</span>
        <span className="text-xs text-muted-foreground">Local</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void refreshDockerContainers()}>
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      {dockerConnectionError ? (
        <div className="border-b border-border bg-card px-3 py-2 text-xs text-destructive">
          {dockerConnectionError}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r border-border scrollbar-sleek">
          <DockerResourceTree
            containers={containers}
            selectedId={selectedContainerId}
            onSelect={selectDockerContainer}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto scrollbar-sleek">
          <DockerContainerDetail container={selected} />
        </div>
      </div>
    </div>
  )
}
