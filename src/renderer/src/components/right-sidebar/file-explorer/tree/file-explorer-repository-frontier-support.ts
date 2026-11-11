import { explorerRepositoryOwner } from './file-explorer-repository-paths'

/** Only net loss of support can retire sources; ancestor counts never widen a changed range. */
export class ExplorerRepositoryFrontierSupport {
  readonly dependencies = new Map<string, number>()
  readonly retained = new Map<string, number>()
  private ancestors = new Map<string, number>()
  private priorDependencies = new Map<string, number>()
  private priorRetained = new Map<string, number>()

  reset(): void {
    this.dependencies.clear()
    this.retained.clear()
    this.ancestors.clear()
    this.priorDependencies.clear()
    this.priorRetained.clear()
  }

  retains(path: string): boolean {
    return (
      this.ancestors.has(path) || explorerRepositoryOwner(this.retained, `${path}/`) !== undefined
    )
  }

  changedRanges(): string[] {
    const paths = new Set<string>()
    for (const [path, before] of this.priorDependencies) {
      if (before > 0 && !this.dependencies.has(path)) {
        paths.add(path)
      }
    }
    for (const [path, before] of this.priorRetained) {
      if (before > 0 && !this.retained.has(path)) {
        paths.add(path)
      }
    }
    this.priorDependencies.clear()
    this.priorRetained.clear()
    return [...paths]
  }

  retain(path: string, delta: number): void {
    this.adjust(this.retained, path, delta, this.priorRetained)
  }

  dependency(path: string, delta: number): void {
    this.adjust(this.dependencies, path, delta, this.priorDependencies)
    for (let ancestor = path; ancestor;) {
      this.adjust(this.ancestors, ancestor, delta)
      const slash = ancestor.lastIndexOf('/')
      ancestor = slash === -1 ? '' : ancestor.slice(0, slash)
    }
  }

  private adjust(
    counts: Map<string, number>,
    path: string,
    delta: number,
    prior?: Map<string, number>
  ): void {
    if (prior && !prior.has(path)) {
      prior.set(path, counts.get(path) ?? 0)
    }
    const count = (counts.get(path) ?? 0) + delta
    if (count > 0) {
      counts.set(path, count)
    } else {
      counts.delete(path)
    }
  }
}
