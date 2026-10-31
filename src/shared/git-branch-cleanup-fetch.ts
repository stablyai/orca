import type { GitBranchCleanupExec } from './git-branch-cleanup'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from './git-fetch-auto-maintenance'
import { isMissingRemoteRefGitError } from './git-missing-remote-ref'
import { sourceRefsForTarget } from './git-fetch-refspec'
export {
  sourceRefsForTarget,
  targetRefsForSource,
  classifyFetchRefspec,
  parseFetchMapping,
  fetchMappingDomainsOverlap,
  compatibleFetchMapping,
  queryFetchTrackingRef,
  resolveFetchTrackingRef,
  type GitFetchSpec
} from './git-fetch-refspec'
export { stockFetchCoverage, indexFetchMappings } from './git-fetch-coverage'
export { indexGitRefs, type GitFetchEffectRow, type GitRefFact } from './git-fetch-ref-index'
export { createFetchEffectProof } from './git-fetch-effect-proof'

function sourceRefForTarget(refspecs: string[], target: string): string | undefined {
  const sources = sourceRefsForTarget(
    refspecs.filter((spec) => !spec.startsWith('^')),
    target
  )
  return sources.length === 1 && sourceRefsForTarget(refspecs, target).includes(sources[0])
    ? sources[0]
    : undefined
}

export async function refreshBranchCleanupTargetRefs(
  runGit: GitBranchCleanupExec,
  targetRefs: readonly string[]
): Promise<string[]> {
  let remotes: string[]
  try {
    remotes = (await runGit(['remote'])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((remote) => remote && !remote.startsWith('-'))
      .sort((left, right) => right.length - left.length)
  } catch {
    return []
  }
  const targetsByRemote = new Map<string, Set<string>>()
  for (const target of targetRefs) {
    const remote = remotes.find((name) => target.startsWith(`refs/remotes/${name}/`))
    if (remote) {
      const targets = targetsByRemote.get(remote) ?? new Set<string>()
      targets.add(target)
      targetsByRemote.set(remote, targets)
    }
  }
  const refreshed: string[] = []
  for (const [remote, targets] of targetsByRemote) {
    let refspecs: string[]
    try {
      refspecs = (await runGit(['config', '--get-all', `remote.${remote}.fetch`])).stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      continue
    }
    const mappings = [...targets].flatMap((target) => {
      const source = sourceRefForTarget(refspecs, target)
      return source ? [{ target, refspec: `+${source}:${target}` }] : []
    })
    if (mappings.length === 0) {
      continue
    }
    const fetch = async (batch: typeof mappings): Promise<void> => {
      // Deletion must not fetch every feature branch or launch disk-heavy auto-maintenance.
      await runGit([
        ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
        'fetch',
        '--no-tags',
        remote,
        ...batch.map((mapping) => mapping.refspec)
      ])
      refreshed.push(...batch.map((mapping) => mapping.target))
    }
    try {
      await fetch(mappings)
    } catch (error) {
      if (mappings.length > 1 && isMissingRemoteRefGitError(error)) {
        // A deleted saved base must not prevent the live default branch from being refreshed.
        for (const mapping of mappings) {
          await fetch([mapping]).catch(() => {})
        }
      }
      // A stale remote-tracking ref cannot prove the remote still retains these changes.
    }
  }
  return refreshed
}
