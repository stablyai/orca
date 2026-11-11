import type { ExplorerRepositoryDiscoveryDebt } from './file-explorer-repository-discovery-debt'
import { GIT_REPOSITORY_PROBE_BATCH_SIZE } from '../../../../../../shared/git/status/git-repository-status'
import type { ExplorerRepositoryCandidate } from './file-explorer-repository-observer'
import type { ExplorerRepositoryRead } from './file-explorer-repository-source'

type DiscoveryOwner = {
  candidates: () => ReadonlyMap<string, ExplorerRepositoryCandidate>
  hasSource: (path: string) => boolean
  validations: Map<string, object>
  debt: ExplorerRepositoryDiscoveryDebt
  invalidListings: WeakSet<object>
  current: () => boolean
  read: ExplorerRepositoryRead
  discovered: (paths: readonly string[]) => void
}

export async function discoverExplorerRepositories(
  owner: DiscoveryOwner,
  signal: AbortSignal
): Promise<void> {
  const candidates = owner.debt.capture()
  for (let start = 0; start < candidates.length; start += GIT_REPOSITORY_PROBE_BATCH_SIZE) {
    if (!owner.current()) {
      return
    }
    const batch = candidates
      .slice(start, start + GIT_REPOSITORY_PROBE_BATCH_SIZE)
      .flatMap((path) => {
        const current = owner.candidates().get(path)
        return current && !owner.hasSource(path) && owner.debt.isReady(path) ? [current] : []
      })
    const unresolved: ExplorerRepositoryCandidate[] = []
    const created: string[] = []
    for (const candidate of batch) {
      if (
        candidate.marker !== undefined &&
        (!candidate.listing || !owner.invalidListings.has(candidate.listing))
      ) {
        owner.validations.set(candidate.path, {})
        owner.debt.delete(candidate.path)
        if (candidate.marker) {
          created.push(candidate.path)
        }
      } else {
        unresolved.push(candidate)
      }
    }
    owner.discovered(created)
    created.length = 0
    if (unresolved.length === 0) {
      continue
    }
    const admitted = new Map<ExplorerRepositoryCandidate, object>()
    for (const candidate of unresolved) {
      const validation = owner.validations.get(candidate.path) ?? {}
      owner.validations.set(candidate.path, validation)
      owner.debt.retry(candidate.path)
      admitted.set(candidate, validation)
    }
    const releaseCanceled = (): void => {
      for (const [candidate, validation] of admitted) {
        if (
          owner.candidates().has(candidate.path) &&
          owner.validations.get(candidate.path) === validation
        ) {
          owner.validations.delete(candidate.path)
          owner.debt.invalidate(candidate.path)
        }
      }
    }
    let results: Awaited<ReturnType<ExplorerRepositoryRead>>
    try {
      results = await owner.read(
        {
          repositoryPaths: unresolved.map((candidate) => candidate.path),
          repositoryIntent: 'probe'
        },
        signal
      )
    } catch {
      if (signal.aborted) {
        releaseCanceled()
        return
      }
      continue
    }
    if (signal.aborted) {
      releaseCanceled()
      return
    }
    if (!owner.current()) {
      return
    }
    // No envelope means unsupported or unknown; never consume an ordinary parent response.
    if (!results) {
      return
    }
    const byPath = new Map(results.map((record) => [record.path, record]))
    for (const [candidate, validation] of admitted) {
      const result = byPath.get(candidate.path)
      if (
        !owner.candidates().has(candidate.path) ||
        owner.validations.get(candidate.path) !== validation ||
        !result ||
        result.kind === 'unknown'
      ) {
        continue
      }
      owner.debt.delete(candidate.path)
      if (result.kind === 'repository') {
        created.push(candidate.path)
      }
    }
    owner.discovered(created)
  }
}
