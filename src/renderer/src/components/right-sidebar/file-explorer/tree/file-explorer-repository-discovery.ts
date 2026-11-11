import { createExplorerRepositoryValidation } from './file-explorer-repository-validation'
import { GIT_REPOSITORY_PROBE_BATCH_SIZE } from '../../../../../../shared/git/status/git-repository-status'
import type { GitStatusRefreshReason } from '../../source-control/sync/git-status-refresh-scheduler'
import type { ExplorerRepositoryCandidate } from './file-explorer-repository-observer'
import type { ExplorerRepositoryRead } from './file-explorer-repository-source'

type DiscoveryOwner = {
  candidates: () => ReadonlyMap<string, ExplorerRepositoryCandidate>
  hasSource: (path: string) => boolean
  evidence: Map<string, object | undefined>
  validations: Map<string, ReturnType<typeof createExplorerRepositoryValidation>>
  invalidListings: WeakSet<object>
  current: () => boolean
  read: ExplorerRepositoryRead
  discovered: (paths: readonly string[]) => void
}

export async function discoverExplorerRepositories(
  owner: DiscoveryOwner,
  reason: GitStatusRefreshReason,
  signal: AbortSignal
): Promise<void> {
  const candidates = [...owner.candidates().values()].filter(
    (candidate) =>
      !owner.hasSource(candidate.path) &&
      (!owner.evidence.has(candidate.path) ||
        Date.now() >= (owner.validations.get(candidate.path)?.dueAt() ?? -Infinity))
  )
  for (let start = 0; start < candidates.length; start += GIT_REPOSITORY_PROBE_BATCH_SIZE) {
    if (!owner.current()) {
      return
    }
    const batch = candidates
      .slice(start, start + GIT_REPOSITORY_PROBE_BATCH_SIZE)
      .flatMap((candidate) => {
        const current = owner.candidates().get(candidate.path)
        return current && !owner.hasSource(candidate.path) ? [current] : []
      })
    const unresolved: ExplorerRepositoryCandidate[] = []
    const created: string[] = []
    for (const candidate of batch) {
      const due = Date.now() >= (owner.validations.get(candidate.path)?.dueAt() ?? -Infinity)
      const revalidate = due && (reason === 'safety' || owner.evidence.has(candidate.path))
      if (revalidate && candidate.listing) {
        owner.invalidListings.add(candidate.listing)
      }
      if (
        !revalidate &&
        candidate.marker !== undefined &&
        (!candidate.listing || !owner.invalidListings.has(candidate.listing))
      ) {
        owner.evidence.set(candidate.path, candidate.listing)
        const validation = createExplorerRepositoryValidation()
        validation.settle(true)
        owner.validations.set(candidate.path, validation)
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
    const admitted = new Map<
      ExplorerRepositoryCandidate,
      ReturnType<typeof createExplorerRepositoryValidation>
    >()
    for (const candidate of unresolved) {
      owner.evidence.set(candidate.path, candidate.listing)
      const validation =
        owner.validations.get(candidate.path) ?? createExplorerRepositoryValidation()
      validation.settle(false)
      owner.validations.set(candidate.path, validation)
      admitted.set(candidate, validation)
    }
    const releaseCanceled = (): void => {
      for (const [candidate, validation] of admitted) {
        if (
          owner.candidates().has(candidate.path) &&
          owner.validations.get(candidate.path) === validation
        ) {
          owner.evidence.delete(candidate.path)
          owner.validations.delete(candidate.path)
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
      owner.evidence.set(candidate.path, candidate.listing)
      validation.settle(true)
      if (result.kind === 'repository') {
        created.push(candidate.path)
      }
    }
    owner.discovered(created)
  }
}

export function repositoryDiscoveryDueAt(
  candidates: ReadonlyMap<string, unknown>,
  sources: ReadonlyMap<string, unknown>,
  validations: ReadonlyMap<string, { dueAt: () => number }>
): number {
  let dueAt = Infinity
  for (const path of candidates.keys()) {
    if (!sources.has(path)) {
      dueAt = Math.min(dueAt, validations.get(path)?.dueAt() ?? -Infinity)
    }
  }
  return dueAt
}
