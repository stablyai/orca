import React, { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildDockerConnectionList } from '@/store/slices/docker'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  LOCAL_DOCKER_CONNECTION,
  LOCAL_DOCKER_CONNECTION_ID
} from '../../../../shared/docker-types'
import type { DockerResourceKind } from '../../../../shared/docker-types'
import { translate } from '@/i18n/i18n'
import { DockerResourceTree } from './DockerResourceTree'
import { DockerContainerDetail } from './DockerContainerDetail'
import { DockerImageDetail } from './DockerImageDetail'
import { DockerVolumeDetail } from './DockerVolumeDetail'
import { DockerNetworkDetail } from './DockerNetworkDetail'
import { DockerConfirmDialog } from './DockerConfirmDialog'
import { useDockerTreeResize } from './use-docker-tree-resize'

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
    resourcesError,
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
      resourcesError: s.resourcesError,
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

  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)

  const connections = buildDockerConnectionList(settings?.dockerConnections)

  const [pruneKind, setPruneKind] = useState<DockerResourceKind | null>(null)

  const { width: treeWidth, isResizing, onResizeStart } = useDockerTreeResize()

  // Derive the selected container id from the unified resource selection.
  const selectedContainerId = selectedResource?.kind === 'container' ? selectedResource.id : null

  // Signal main to start polling while this panel is mounted, stop when it unmounts.
  useEffect(() => {
    void window.api.docker.setPollingActive({ active: true })
    return () => {
      void window.api.docker.setPollingActive({ active: false })
    }
  }, [])

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
    if (selectedContainerId) {
      void inspectDockerContainer(selectedContainerId)
    }
  }, [selectedContainerId, activeConnectionId, inspectDockerContainer])

  const containers = containersByConnection[activeConnectionId] ?? []
  const images = imagesByConnection[activeConnectionId] ?? []
  const volumes = volumesByConnection[activeConnectionId] ?? []
  const networks = networksByConnection[activeConnectionId] ?? []
  const connection =
    buildDockerConnectionList(settings?.dockerConnections).find(
      (c) => c.id === activeConnectionId
    ) ?? LOCAL_DOCKER_CONNECTION

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
            inspect={
              selectedContainerId ? (inspectByContainerId[selectedContainerId] ?? null) : null
            }
            inspectError={
              selectedContainerId ? (inspectErrorByContainerId[selectedContainerId] ?? null) : null
            }
          />
        )
      }
      case 'image': {
        const img = images.find((x) => x.id === selectedResource.id)
        return img ? (
          <DockerImageDetail image={img} />
        ) : (
          <DockerContainerDetail
            container={null}
            connection={connection}
            inspect={null}
            inspectError={null}
          />
        )
      }
      case 'volume': {
        const vol = volumes.find((x) => x.name === selectedResource.id)
        return vol ? (
          <DockerVolumeDetail volume={vol} />
        ) : (
          <DockerContainerDetail
            container={null}
            connection={connection}
            inspect={null}
            inspectError={null}
          />
        )
      }
      case 'network': {
        const net = networks.find((x) => x.id === selectedResource.id)
        return net ? (
          <DockerNetworkDetail network={net} />
        ) : (
          <DockerContainerDetail
            container={null}
            connection={connection}
            inspect={null}
            inspectError={null}
          />
        )
      }
    }
  }

  const handlePruneConfirm = async (): Promise<void> => {
    if (!pruneKind) {
      return
    }
    try {
      await pruneDockerResources(pruneKind)
    } catch (error) {
      toast.error(translate('auto.components.docker.DockerPage.1225452538', 'Prune failed'), {
        description: String(error)
      })
      throw error // keep the confirm dialog open on failure
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Docker</span>
        <Select
          value={activeConnectionId}
          onValueChange={(id) => void setActiveDockerConnection(id)}
        >
          <SelectTrigger size="sm" className="h-7 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            openSettingsTarget({ pane: 'docker', repoId: null })
            openSettingsPage()
          }}
        >
          {translate('auto.components.docker.DockerPage.77e6e492c6', 'Manage connections')}
        </Button>
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
          <TooltipContent>
            {translate('auto.components.docker.DockerPage.3b170f8fdb', 'Refresh')}
          </TooltipContent>
        </Tooltip>
      </div>
      {dockerConnectionError ? (
        <div className="border-b border-border bg-card px-3 py-2 text-xs text-destructive">
          {dockerConnectionError}
        </div>
      ) : null}
      {resourcesError ? (
        <div className="border-b border-border bg-card px-3 py-2 text-xs text-destructive">
          {resourcesError}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div
          className="relative shrink-0 overflow-y-auto border-r border-border scrollbar-sleek"
          style={{ width: treeWidth }}
        >
          <DockerResourceTree
            containers={containers}
            images={images}
            volumes={volumes}
            networks={networks}
            selected={selectedResource}
            onSelect={selectResource}
            onPrune={(kind) => setPruneKind(kind)}
          />
          {/* Why: matches the app's 4px pointer-event target on sidebar/kanban resize handles. */}
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onResizeStart}
            className={cn(
              'absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 active:bg-ring/30',
              isResizing && 'bg-ring/30'
            )}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{renderDetail()}</div>
      </div>

      {pruneKind !== null ? (
        <DockerConfirmDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setPruneKind(null)
            }
          }}
          title={translate('auto.components.docker.DockerPage.916726d215', 'Prune {{value0}}', {
            value0: kindLabel(pruneKind)
          })}
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
