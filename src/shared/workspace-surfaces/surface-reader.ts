import type { SurfaceKey, WorkspaceSurface } from './surface-content'

export type WorkspaceSurfaceReader = {
  hostIds?(): readonly string[]
  initialized(hostId: string): boolean
  chatInitialized?(hostId: string): boolean
  unresolvedNativeSessionIds?(hostId: string): ReadonlySet<string>
  read(key: SurfaceKey): WorkspaceSurface | null
  all(hostId: string): readonly WorkspaceSurface[]
}
