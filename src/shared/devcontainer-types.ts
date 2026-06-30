/**
 * Devcontainer DTO types shared across main, preload, and renderer.
 *
 * These live in `shared` (not `main`) so the preload `api` surface and the
 * renderer Add-Project UI can reference them without importing main-only modules
 * (which would break the renderer/preload project boundary).
 */

/** Worktrees live inside the bind mount so the in-container agent can see them. */
export const DEVCONTAINER_WORKTREE_BASE_PATH = '.worktrees'

/** One bind/volume mount from `docker inspect` `.Mounts[]`. */
export type ContainerMount = {
  /** Absolute host path (`.Mounts[].Source`). */
  source: string
  /** Absolute in-container path (`.Mounts[].Destination`). */
  destination: string
}

/** A discovered devcontainer the Add-Project flow can offer as a project. */
export type DevcontainerInfo = {
  /** Current container id (changes when the container is recreated). */
  containerId: string
  /** Container name without the leading slash docker reports. */
  name: string
  /** Host workspace folder (`devcontainer.local_folder`) — the bind-mount root. */
  hostFolder: string
  /** Path to the devcontainer.json, when the label is present. */
  configFile: string | null
  /** Whether the container is currently running. */
  running: boolean
  /** Bind/volume mounts, for host↔container path translation. */
  mounts: ContainerMount[]
}
