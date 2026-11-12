import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import type { DirCache, FileExplorerOperationOwner } from './file-explorer-types'

export function sameRepositoryListingOwner(
  a: FileExplorerOperationOwner | undefined,
  b: FileExplorerOperationOwner
): boolean {
  return (
    a?.kind === b.kind &&
    (b.kind === 'ssh'
      ? a.kind === 'ssh' && a.connectionId === b.connectionId
      : b.kind === 'runtime'
        ? a.kind === 'runtime' &&
          a.environmentId === b.environmentId &&
          a.executionHostId === b.executionHostId
        : true)
  )
}

/** Protected edges survive uncertain omissions, but never a proven identity break. */
export class ExplorerRepositoryProofEdges {
  private parents = new Map<string, Set<string>>()

  constructor(
    private root: string,
    private owner: FileExplorerOperationOwner,
    private branches: (path: string) => readonly string[],
    private invalidate: (path: string) => void
  ) {}

  commit(path: string, listing: DirCache | undefined): void {
    const relative = relativePathInsideRoot(this.root, path)
    if (relative === null) {
      return
    }
    let protectedEdges = this.parents.get(relative)
    if (!protectedEdges) {
      protectedEdges = new Set(this.branches(relative))
      if (!protectedEdges.size) {
        return
      }
      this.parents.set(relative, protectedEdges)
    }
    if (
      !protectedEdges.size ||
      !listing ||
      listing.error !== undefined ||
      !sameRepositoryListingOwner(listing.operationOwner, this.owner)
    ) {
      return
    }
    const present = new Set<string>()
    if (!listing.outsideProject) {
      for (const child of listing.children) {
        const childPath = relativePathInsideRoot(this.root, child.path)
        if (childPath === null || !protectedEdges.has(childPath)) {
          continue
        }
        if (
          child.isDirectory &&
          !child.isSymlink &&
          !child.outsideProject &&
          sameRepositoryListingOwner(child.operationOwner, this.owner)
        ) {
          present.add(childPath)
        } else {
          this.invalidate(childPath)
          protectedEdges.delete(childPath)
        }
      }
    }
    if (!listing.more || listing.outsideProject) {
      for (const child of protectedEdges) {
        if (!present.has(child)) {
          this.invalidate(child)
          protectedEdges.delete(child)
        }
      }
    }
  }

  clear(): void {
    this.parents.clear()
  }
}
