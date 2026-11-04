import type { SurfaceSessionProjectionCache } from './surface-session-projection-cache'
import type { SurfaceKey, WorkspaceSurface } from './surface-content'

export type WorkspaceSurfaceReader = {
  hostIds?(): readonly string[]
  initialized(hostId: string): boolean
  revision?(hostId: string): number
  chatInitialized?(hostId: string): boolean
  unresolvedNativeSessionIds?(hostId: string): ReadonlySet<string>
  read(key: SurfaceKey): WorkspaceSurface | null
  projectionCache?(hostId: string): SurfaceSessionProjectionCache | undefined
  workspace?(hostId: string, workspaceId: string): readonly WorkspaceSurface[]
  terminal?(key: SurfaceKey): WorkspaceSurface | null
  all(hostId: string): readonly WorkspaceSurface[]
}
