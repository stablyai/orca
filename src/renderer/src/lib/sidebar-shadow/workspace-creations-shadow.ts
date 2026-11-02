import { WorkspaceCreationsSnapshotSchema } from '../../../../shared/sidebar-list/workspace-creations'
import { readHostCreationRequests } from './host-creation-requests'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'

/**
 * Scoped to creations this window asked its own host for: preflight never reached the host, a
 * paired server's creations are its own, and a phone's or the CLI's have no pending entry here.
 */
export const workspaceCreationsShadow = defineSidebarShadowDomain<string>({
  name: 'workspace-creations',
  readWindow: () => {
    const repoIdByCreationId = new Map<string, string>()
    for (const [creationId, request] of readHostCreationRequests()) {
      if (request.inFlight) {
        repoIdByCreationId.set(creationId, request.repoId)
      }
    }
    return repoIdByCreationId
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.workspaceCreations' })
    const parsed = response.ok ? WorkspaceCreationsSnapshotSchema.safeParse(response.result) : null
    if (!parsed?.success) {
      return null
    }
    const requested = readHostCreationRequests()
    const repoIdByCreationId = new Map<string, string>()
    for (const [creationId, creation] of Object.entries(parsed.data.creations)) {
      if (requested.has(creationId)) {
        repoIdByCreationId.set(creationId, creation.repoId)
      }
    }
    return { revision: parsed.data.revision, values: repoIdByCreationId }
  },
  equals: (window, main) => window === main
})
