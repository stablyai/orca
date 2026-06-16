import React, { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildDockerConnectionList } from '@/store/slices/docker'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LOCAL_DOCKER_CONNECTION, LOCAL_DOCKER_CONNECTION_ID } from '../../../../shared/docker-types'
import type { DockerResourceKind } from '../../../../shared/docker-types'
import { DockerResourceTree } from './DockerResourceTree'
import { DockerContainerDetail } from './DockerContainerDetail'

export default function DockerPage(): React.JSX.Element {
  const {
    activeConnectionId,
    containersByConnection,
    imagesByConnection,
    volumesByConnection,
    networksByConnection,
    selectedResource,
    dockerConnectionError,
    settings,
    inspectByContainerId,
    inspectErrorByContainerId,
    setActiveDockerConnection,
    refreshDockerContainers,
    refreshDockerResources,
    pruneDockerResources,
    selectResource,
    inspectDockerContainer
  } = useAppStore(
    useShallow((s) => ({
      activeConnectionId: s.activeConnectionId,
      containersByConnection: s.containersByConnection,
      imagesByConnection: s.imagesByConnection,
      volumesByConnection: s.volumesByConnection,
      networksByConnection: s.networksByConnection,
      selectedResource: s.selectedResource,
      dockerConnectionError: s.dockerConnectionError,
      settings: s.settings,
      inspectByContainerId: s.inspectByContainerId,
      inspectErrorByContainerId: s.inspectErrorByContainerId,
      setActiveDockerConnection: s.setActiveDockerConnection,
      refreshDockerContainers: s.refreshDockerContainers,
      refreshDockerResources: s.refreshDockerResources,
      pruneDockerResources: s.pruneDockerResources,
      selectResource: s.selectResource,
      inspectDockerContainer: s.inspectDockerContainer
    }))
  )

  // Derive the selected container id from the unified resource selection.
  const selectedContainerId =
    selectedResource?.kind === 'container' ? selectedResource.id : null

  // Connect to the local daemon on first open and fetch all resources.
  useEffect(() => {
    void setActiveDockerConnection(LOCAL_DOCKER_CONNECTION_ID)
    void refreshDockerResources()
  }, [setActiveDockerConnection, refreshDockerResources])

  // Re-fetch resources whenever the active connection changes.
  useEffect(() => {
    void refreshDockerResources()
  }, [activeConnectionId, refreshDockerResources])

  // Trigger inspect whenever the selected container or active connection changes.
  useEffect(() => {
    if (selectedContainerId) void inspectDockerContainer(selectedContainerId)
  }, [selectedContainerId, activeConnectionId, inspectDockerContainer])

  const containers = containersByConnection[activeConnectionId] ?? []
  const images = imagesByConnection[activeConnectionId] ?? []
  const volumes = volumesByConnection[activeConnectionId] ?? []
  const networks = networksByConnection[activeConnectionId] ?? []
  const selected = containers.find((c) => c.id === selectedContainerId) ?? null
  const connection =
    buildDockerConnectionList(settings?.dockerConnections).find((c) => c.id === activeConnectionId) ??
    LOCAL_DOCKER_CONNECTION

  async function prune(kind: DockerResourceKind): Promise<void> {
    try {
      await pruneDockerResources(kind)
    } catch (error) {
      toast.error('Prune failed', { description: String(error) })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Docker</span>
        <span className="text-xs text-muted-foreground">Local</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                void refreshDockerContainers()
                void refreshDockerResources()
              }}
            >
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
            images={images}
            volumes={volumes}
            networks={networks}
            selected={selectedResource}
            onSelect={selectResource}
            onPrune={(kind) => void prune(kind)}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">
          <DockerContainerDetail
            container={selected}
            connection={connection}
            inspect={selectedContainerId ? (inspectByContainerId[selectedContainerId] ?? null) : null}
            inspectError={selectedContainerId ? (inspectErrorByContainerId[selectedContainerId] ?? null) : null}
          />
        </div>
      </div>
    </div>
  )
}
