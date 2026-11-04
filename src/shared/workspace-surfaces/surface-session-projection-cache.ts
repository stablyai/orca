import type { WorkspaceLayout } from '../workspace-layout/workspace-layout-model'
import type { WorkspaceSurface } from './surface-content'
import { projectSurfaceWorkspace } from './surface-layout'

/** Owned by one immutable visible host revision; presentation inputs remain part of every lookup. */
export class SurfaceSessionProjectionCache {
  readonly terminalEntityIds = new Set<string>()
  private readonly openWorkspaces = new Set<string>()
  private readonly nativeIds = new Map<string, Set<string>>()
  private readonly groups = new Map<string, WorkspaceSurface[]>()
  private readonly projected = new Map<string, { input: string; value: WorkspaceLayout }>()

  constructor(surfaces: readonly WorkspaceSurface[], previous?: SurfaceSessionProjectionCache) {
    for (const surface of surfaces) {
      const group = this.groups.get(surface.workspaceId) ?? []
      group.push(surface)
      this.groups.set(surface.workspaceId, group)
      if (surface.content) {
        this.openWorkspaces.add(surface.workspaceId)
      }
      if (surface.content?.kind === 'terminal') {
        this.terminalEntityIds.add(surface.content.entityId)
      }
      if (surface.content?.kind === 'agent-session') {
        const ids = this.nativeIds.get(surface.workspaceId) ?? new Set<string>()
        ids.add(surface.content.sessionId)
        this.nativeIds.set(surface.workspaceId, ids)
      }
    }
    for (const [workspaceId, group] of this.groups) {
      const prior = previous?.groups.get(workspaceId)
      if (
        prior?.length === group.length &&
        group.every((surface, index) => {
          const before = prior[index]!
          return (
            before.hostTabId === surface.hostTabId &&
            before.occurrence === surface.occurrence &&
            before.revision === surface.revision
          )
        })
      ) {
        const entry = previous?.projected.get(workspaceId)
        if (entry) {
          this.projected.set(workspaceId, entry)
        }
      }
    }
  }

  workspaceIds(): IterableIterator<string> {
    return this.openWorkspaces.keys()
  }

  project(
    workspaceId: string,
    view: WorkspaceLayout | undefined,
    chatVerified: boolean,
    unresolved: ReadonlySet<string>,
    shown: ReadonlySet<string>
  ): WorkspaceLayout {
    const relevant = new Set([
      ...(this.nativeIds.get(workspaceId) ?? []),
      ...(view?.tabs.flatMap((tab) => (tab.kind === 'agent-session' ? [tab.entityId] : [])) ?? [])
    ])
    const unresolvedHere = new Set([...relevant].filter((id) => unresolved.has(id)))
    const shownHere = new Set([...relevant].filter((id) => shown.has(id)))
    const input = JSON.stringify([view, chatVerified, [...unresolvedHere], [...shownHere]])
    const prior = this.projected.get(workspaceId)
    if (prior?.input === input) {
      return structuredClone(prior.value)
    }
    const value = projectSurfaceWorkspace(
      workspaceId,
      view,
      this.groups.get(workspaceId) ?? [],
      chatVerified,
      unresolvedHere,
      shownHere
    )
    this.projected.set(workspaceId, { input, value: structuredClone(value) })
    return value
  }
}
