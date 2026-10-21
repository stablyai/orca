/**
 * A local project the WSL host now owns. Its existing chats stay on this computer, so the desktop
 * lists it read-only under its own entry; new work, terminals and edits belong to the host.
 */
export type WslMovedProjectKind = 'repo' | 'folder'

export type WslMovedProject = {
  kind: WslMovedProjectKind
  /** The local row's id; the host's row carries the same id on another host. */
  id: string
  displayName: string
  /** The local (UNC) path the project ran at before the move. */
  path: string
  distro: string
}
