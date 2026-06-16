import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  LOCAL_DOCKER_CONNECTION,
  LOCAL_DOCKER_CONNECTION_ID,
  type DockerConnection,
  type DockerConnectionStatus,
  type DockerContainerAction,
  type DockerContainerInspect,
  type DockerContainerSummary,
  type DockerImageSummary,
  type DockerNetworkSummary,
  type DockerResourceKind,
  type DockerResourceSelection,
  type DockerResourcesChangedEvent,
  type DockerVolumeSummary
} from '../../../../shared/docker-types'

export function buildDockerConnectionList(
  userConnections: DockerConnection[] | null | undefined
): DockerConnection[] {
  // Filter out any stray entry that collides with the built-in local id so the
  // canonical LOCAL_DOCKER_CONNECTION always appears exactly once at index 0.
  const extras = (userConnections ?? []).filter((c) => c.id !== LOCAL_DOCKER_CONNECTION_ID)
  return [LOCAL_DOCKER_CONNECTION, ...extras]
}

export type DockerSlice = {
  activeConnectionId: string
  dockerConnectionStatus: DockerConnectionStatus
  dockerConnectionError: string | null
  containersByConnection: Record<string, DockerContainerSummary[]>
  selectedResource: DockerResourceSelection | null
  inspectByContainerId: Record<string, DockerContainerInspect>
  inspectErrorByContainerId: Record<string, string>
  setActiveDockerConnection: (connectionId: string) => Promise<void>
  refreshDockerContainers: () => Promise<void>
  applyDockerResources: (event: DockerResourcesChangedEvent) => void
  selectResource: (selection: DockerResourceSelection | null) => void
  inspectDockerContainer: (containerId: string) => Promise<void>
  actionPendingByContainerId: Record<string, boolean>
  runDockerContainerAction: (containerId: string, action: DockerContainerAction) => Promise<void>
  imagesByConnection: Record<string, DockerImageSummary[]>
  volumesByConnection: Record<string, DockerVolumeSummary[]>
  networksByConnection: Record<string, DockerNetworkSummary[]>
  resourcesError: string | null
  refreshDockerResources: () => Promise<void>
  removeDockerResource: (kind: DockerResourceKind, id: string) => Promise<void>
  pruneDockerResources: (kind: DockerResourceKind) => Promise<void>
}

export const createDockerSlice: StateCreator<AppState, [], [], DockerSlice> = (set, get) => ({
  activeConnectionId: LOCAL_DOCKER_CONNECTION_ID,
  dockerConnectionStatus: 'unknown',
  dockerConnectionError: null,
  containersByConnection: {},
  selectedResource: null,
  inspectByContainerId: {},
  inspectErrorByContainerId: {},
  actionPendingByContainerId: {},
  imagesByConnection: {},
  volumesByConnection: {},
  networksByConnection: {},
  resourcesError: null,

  setActiveDockerConnection: async (connectionId) => {
    set({ activeConnectionId: connectionId, selectedResource: null })
    const ping = await window.api.docker.pingConnection({ connectionId })
    set({ dockerConnectionStatus: ping.status, dockerConnectionError: ping.error ?? null })
    if (ping.status === 'reachable') {
      await get().refreshDockerContainers()
    }
  },

  refreshDockerContainers: async () => {
    const connectionId = get().activeConnectionId
    try {
      const containers = await window.api.docker.listContainers({ connectionId })
      set((s) => ({
        containersByConnection: { ...s.containersByConnection, [connectionId]: containers },
        dockerConnectionStatus: 'reachable',
        dockerConnectionError: null
      }))
    } catch (error) {
      set({ dockerConnectionStatus: 'unreachable', dockerConnectionError: String(error) })
    }
  },

  applyDockerResources: (event) => {
    set((s) => ({
      containersByConnection: {
        ...s.containersByConnection,
        [event.connectionId]: event.containers
      }
    }))
  },

  selectResource: (selection) => set({ selectedResource: selection }),

  runDockerContainerAction: async (containerId, action) => {
    const connectionId = get().activeConnectionId
    set((s) => ({
      actionPendingByContainerId: { ...s.actionPendingByContainerId, [containerId]: true }
    }))
    try {
      await window.api.docker.containerAction({ connectionId, containerId, action })
      if (
        action === 'remove' &&
        get().selectedResource?.kind === 'container' &&
        get().selectedResource?.id === containerId
      ) {
        set({ selectedResource: null })
      }
      // Optimistic refresh: reflect the new state immediately rather than waiting for the poll.
      await get().refreshDockerContainers()
    } catch (error) {
      // Still refresh so the row shows its true state; rethrow so the UI can toast.
      await get().refreshDockerContainers()
      throw error
    } finally {
      set((s) => {
        const next = { ...s.actionPendingByContainerId }
        delete next[containerId]
        return { actionPendingByContainerId: next }
      })
    }
  },

  inspectDockerContainer: async (containerId) => {
    const connectionId = get().activeConnectionId
    try {
      const inspect = await window.api.docker.inspect({ connectionId, containerId })
      set((s) => ({
        inspectByContainerId: { ...s.inspectByContainerId, [containerId]: inspect },
        inspectErrorByContainerId: (() => {
          const next = { ...s.inspectErrorByContainerId }
          delete next[containerId]
          return next
        })()
      }))
    } catch (error) {
      set((s) => ({
        inspectErrorByContainerId: { ...s.inspectErrorByContainerId, [containerId]: String(error) }
      }))
    }
  },

  refreshDockerResources: async () => {
    const connectionId = get().activeConnectionId
    try {
      const [images, volumes, networks] = await Promise.all([
        window.api.docker.listImages({ connectionId }),
        window.api.docker.listVolumes({ connectionId }),
        window.api.docker.listNetworks({ connectionId })
      ])
      set((s) => ({
        imagesByConnection: { ...s.imagesByConnection, [connectionId]: images },
        volumesByConnection: { ...s.volumesByConnection, [connectionId]: volumes },
        networksByConnection: { ...s.networksByConnection, [connectionId]: networks },
        resourcesError: null
      }))
    } catch (error) {
      set({ resourcesError: String(error) })
    }
  },

  removeDockerResource: async (kind, id) => {
    const connectionId = get().activeConnectionId
    await window.api.docker.resourceRemove({ connectionId, kind, id })
    if (get().selectedResource?.kind === kind && get().selectedResource?.id === id) {
      set({ selectedResource: null })
    }
    if (kind === 'container') await get().refreshDockerContainers()
    else await get().refreshDockerResources()
  },

  pruneDockerResources: async (kind) => {
    const connectionId = get().activeConnectionId
    await window.api.docker.resourcePrune({ connectionId, kind })
    if (kind === 'container') await get().refreshDockerContainers()
    else await get().refreshDockerResources()
  },
})
