import React, { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildDockerConnectionList } from '@/store/slices/docker'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LOCAL_DOCKER_CONNECTION, LOCAL_DOCKER_CONNECTION_ID } from '../../../../shared/docker-types'
import type { DockerResourceKind } from '../../../../shared/docker-types'
import { translate } from '@/i18n/i18n'
import { DockerResourceTree } from './DockerResourceTree'
import { DockerContainerDetail } from './DockerContainerDetail'
import { DockerImageDetail } from './DockerImageDetail'
import { DockerVolumeDetail } from './DockerVolumeDetail'
import { DockerNetworkDetail } from './DockerNetworkDetail'
import { DockerConfirmDialog } from './DockerConfirmDialog'

function kindLabel(kind: DockerResourceKind): string {
  // Why: literal-key translate calls so the catalog scanner can detect and sync these strings.
  switch (kind) {
    case 'container':
      return translate('auto.components.docker.DockerPage.e33ba23c23', 'container')
    case 'image':
      return translate('auto.components.docker.DockerPage.286b0c6e34', 'image')
    case 'volume':
      return translate('auto.components.docker.DockerPage.9ee5213fa5', 'volume')
    case 'network':
      return translate('auto.components.docker.DockerPage.9b72705845', 'network')
  }
}

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

  const [pruneKind, setPruneKind] = useState<DockerResourceKind | null>(null)

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
  const connection =
    buildDockerConnectionList(settings?.dockerConnections).find((c) => c.id === activeConnectionId) ??
    LOCAL_DOCKER_CONNECTION

  function renderDetail(): React.JSX.Element {
    if (!selectedResource) {
      return (
        <DockerContainerDetail
          container={null}
          connection={connection}
          inspect={null}
          inspectError={null}
        />
      )
    }
    switch (selectedResource.kind) {
      case 'container': {
        const c = containers.find((x) => x.id === selectedResource.id) ?? null
        return (
          <DockerContainerDetail
            container={c}
            connection={connection}
            inspect={selectedContainerId ? (inspectByContainerId[selectedContainerId] ?? null) : null}
            inspectError={selectedContainerId ? (inspectErrorByContainerId[selectedContainerId] ?? null) : null}
          />
        )
      }
      case 'image': {
        const img = images.find((x) => x.id === selectedResource.id)
        return img ? (
          <DockerImageDetail image={img} />
        ) : (
          <DockerContainerDetail container={null} connection={connection} inspect={null} inspectError={null} />
        )
      }
      case 'volume': {
        const vol = volumes.find((x) => x.name === selectedResource.id)
        return vol ? (
          <DockerVolumeDetail volume={vol} />
        ) : (
          <DockerContainerDetail container={null} connection={connection} inspect={null} inspectError={null} />
        )
      }
      case 'network': {
        const net = networks.find((x) => x.id === selectedResource.id)
        return net ? (
          <DockerNetworkDetail network={net} />
        ) : (
          <DockerContainerDetail container={null} connection={connection} inspect={null} inspectError={null} />
        )
      }
    }
  }

  const handlePruneConfirm = async (): Promise<void> => {
    if (!pruneKind) return
    try {
      await pruneDockerResources(pruneKind)
    } catch (error) {
      toast.error(
        translate('auto.components.docker.DockerPage.1225452538', 'Prune failed'),
        { description: String(error) }
      )
      throw error // keep the confirm dialog open on failure
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
          <TooltipContent>{translate('auto.components.docker.DockerPage.3b170f8fdb', 'Refresh')}</TooltipContent>
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
            onPrune={(kind) => setPruneKind(kind)}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">
          {renderDetail()}
        </div>
      </div>

      {pruneKind !== null ? (
        <DockerConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setPruneKind(null) }}
          title={translate(
            'auto.components.docker.DockerPage.916726d215',
            'Prune {{value0}}',
            { value0: kindLabel(pruneKind) }
          )}
          description={translate(
            'auto.components.docker.DockerPage.79cedd713b',
            'Prune all stopped {{value0}} resources? This cannot be undone.',
            { value0: kindLabel(pruneKind) }
          )}
          confirmLabel={translate('auto.components.docker.DockerPage.59c7b69676', 'Prune')}
          onConfirm={handlePruneConfirm}
        />
      ) : null}
    </div>
  )
}
