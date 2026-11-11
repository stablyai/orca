import { explorerRepositoryOwner } from './file-explorer-repository-paths'
import type { FsChangeEvent } from '../../../../../../shared/file-watch/filesystem-change-event'

export type ExplorerRepositoryChange = {
  path: string
  directory?: boolean
  kind: Exclude<FsChangeEvent['kind'], 'overflow'>
}
type PathNode = { member: boolean; children: Map<string, PathNode> }

/** Membership and queries follow path segments, including immediately after a local edit. */
export class ExplorerRepositoryPathIndex {
  private root: PathNode = { member: false, children: new Map() }

  add(path: string): void {
    let node = this.root
    for (const part of path ? path.split('/') : []) {
      let child = node.children.get(part)
      if (!child) {
        child = { member: false, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
    node.member = true
  }

  delete(path: string): void {
    let node = this.root
    const parents: [PathNode, string][] = []
    for (const part of path ? path.split('/') : []) {
      const child = node.children.get(part)
      if (!child) {
        return
      }
      parents.push([node, part])
      node = child
    }
    node.member = false
    for (
      let index = parents.length - 1;
      index >= 0 && !node.member && !node.children.size;
      index--
    ) {
      const [parent, part] = parents[index]
      parent.children.delete(part)
      node = parent
    }
  }

  has(path: string): boolean {
    return this.find(path)?.member === true
  }

  set(paths: Iterable<string>): void {
    this.root = { member: false, children: new Map() }
    for (const path of paths) {
      this.add(path)
    }
  }

  private find(path: string): PathNode | undefined {
    let node: PathNode | undefined = this.root
    for (const part of path ? path.split('/') : []) {
      node = node?.children.get(part)
    }
    return node
  }

  descendants(paths: readonly string[]): Set<string> {
    const roots = new Set(paths)
    const found = new Set<string>()
    for (const path of roots) {
      const slash = path.lastIndexOf('/')
      const parent = slash === -1 ? '' : path.slice(0, slash)
      if (path && explorerRepositoryOwner(roots, `${parent}/`) !== undefined) {
        continue
      }
      const node = this.find(path)
      if (!node) {
        continue
      }
      const pending: [string, PathNode][] = [[path, node]]
      while (pending.length) {
        const [currentPath, current] = pending.pop()!
        if (current.member) {
          found.add(currentPath)
        }
        for (const [part, child] of current.children) {
          pending.push([currentPath ? `${currentPath}/${part}` : part, child])
        }
      }
    }
    return found
  }

  related(paths: readonly string[]): Set<string> {
    const found = this.descendants(paths)
    for (let path of paths) {
      for (;;) {
        if (this.has(path)) {
          found.add(path)
        }
        if (!path) {
          break
        }
        const slash = path.lastIndexOf('/')
        path = slash === -1 ? '' : path.slice(0, slash)
      }
    }
    return found
  }
}

export function collectExplorerRepositoryInvalidation(
  changes: readonly ExplorerRepositoryChange[],
  sources: ReadonlyMap<string, unknown>,
  sourceIndex: ExplorerRepositoryPathIndex,
  candidateIndex: ExplorerRepositoryPathIndex
) {
  const directories = changes.filter((change) => change.directory || change.kind !== 'update')
  const affected = sourceIndex.descendants(directories.map((change) => change.path))
  const proofOwners = sourceIndex.descendants(
    changes.filter((change) => change.kind !== 'update').map((change) => change.path)
  )
  const ignoreOwners = new Set<string | undefined>(proofOwners)
  for (const { path } of changes) {
    const owner = explorerRepositoryOwner(sources, `${path}/`)
    if (owner !== undefined) {
      affected.add(owner)
    }
    const marker = /(?:^|\/)\.git(?:\/|$)/.exec(path)
    const proofRoot = marker ? path.slice(0, marker.index) : undefined
    if (proofRoot !== undefined && sources.has(proofRoot)) {
      proofOwners.add(proofRoot)
      ignoreOwners.add(proofRoot)
    }
    if (path.endsWith('/.gitignore') || path === '.gitignore' || path.includes('/.git/')) {
      ignoreOwners.add(owner)
    }
  }
  const identityPaths: string[] = []
  const discoveryCandidates = new Set<string>()
  for (const change of changes) {
    const marker = /(?:^|\/)\.git(?:\/|$)/.exec(change.path)
    const exact = marker ? change.path.slice(0, marker.index) : change.path
    if (marker || (change.kind === 'update' && change.directory)) {
      if (candidateIndex.has(exact)) {
        discoveryCandidates.add(exact)
      }
    } else if (change.kind !== 'update') {
      identityPaths.push(change.path)
    }
  }
  for (const path of candidateIndex.related(identityPaths)) {
    discoveryCandidates.add(path)
  }
  return {
    affected,
    proofOwners,
    ignoreOwners,
    deleted: new Set(
      changes.filter((change) => change.kind === 'delete').map((change) => change.path)
    ),
    discoveryCandidates
  }
}
