import { acquireGitNativeFacts } from './git-worktree-admin'
import { createFetchEffectProof, resolveFetchTrackingRef } from './git-branch-cleanup-fetch'
import type { GitCommandRunner } from './git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import {
  createGitConfigSnapshotRunner,
  parseGitConfigListSnapshot,
  GitConfigSnapshotKeyNotFoundError,
  type GitConfigSnapshot
} from './git-config-snapshot-runner'

export type ResolvedGitPushTarget = {
  remote: string
  refspec: string
}

async function getConfigValue(runGit: GitCommandRunner, key: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', key])
    const value = stdout.trim()
    return value || null
  } catch (error) {
    if (
      error instanceof GitConfigSnapshotKeyNotFoundError ||
      (error instanceof Error && 'code' in error && error.code === 1)
    ) {
      return null
    }
    throw error
  }
}

function isUrlValuedRemote(remote: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@/:]+@[^:]+:.+/.test(remote)
}

type ConfiguredPushRemote = {
  remote: string
  identity: string
  branchRemote: string | null
}

async function getConfiguredPushRemote(
  runGit: GitCommandRunner,
  branch: string,
  getSnapshot: () => GitConfigSnapshot | undefined,
  source: string,
  context?: GitPushResolutionContext
): Promise<ConfiguredPushRemote | null> {
  const branchRemote = await getConfigValue(runGit, `branch.${branch}.remote`)
  const remote =
    (await getConfigValue(runGit, `branch.${branch}.pushRemote`)) ??
    (await getConfigValue(runGit, 'remote.pushDefault')) ??
    branchRemote
  if (!remote) {
    return null
  }
  const config = getSnapshot()
  if (
    !config ||
    (!isUrlValuedRemote(remote) && (!branchRemote || !isUrlValuedRemote(branchRemote)))
  ) {
    return { remote, identity: remote, branchRemote }
  }
  const original = { remote, identity: remote, branchRemote }
  try {
    const cwd = context?.cwd ?? (await runGit(['rev-parse', '--show-toplevel'])).stdout.trimEnd()
    const exec = context?.exec ?? ((args: string[], at: string) => runGit(['-C', at, ...args]))
    const facts = await acquireGitNativeFacts(
      exec,
      cwd,
      context?.scope,
      isUrlValuedRemote(remote) ? remote : branchRemote!
    )
    const fetch = facts.urls
    const push = facts.pushes
    const literal = facts.intended!.pushes
    const matched = [...fetch].find(([, url]) => url === facts.intended!.url)?.[0]
    const identity = isUrlValuedRemote(remote) ? (matched ?? remote) : remote
    let selected: string | undefined
    if (isUrlValuedRemote(remote) && literal.length === 1) {
      const proof = createFetchEffectProof(facts.mappings, facts.refs, (a, b) => a === b)
      selected = [...fetch].find(([name, url]) => {
        const endpoints = push.get(name) ?? []
        const specs = facts.policy.get(name)?.get('fetch') ?? []
        const destination = resolveFetchTrackingRef(specs, source)
        return (
          url === literal[0] &&
          endpoints.length === 1 &&
          endpoints[0] === literal[0] &&
          !facts.booleans.get(`remote.${name}.mirror`) &&
          Boolean(destination) &&
          proof.unambiguous(name, source, destination!) &&
          proof.operation(url, specs, source, 'push', facts.booleans.get('push.followtags'))
        )
      })?.[0]
    }
    return {
      remote: isUrlValuedRemote(remote) ? (selected ?? remote) : remote,
      identity,
      branchRemote:
        branchRemote === remote
          ? identity
          : !isUrlValuedRemote(remote)
            ? (matched ?? branchRemote)
            : ([...fetch].find(([, url]) => url === branchRemote)?.[0] ?? branchRemote)
    }
  } catch {
    return original
  }
}

async function branchMergeTargetsConfiguredBase(
  runGit: GitCommandRunner,
  branch: string,
  remote: string,
  branchRef: string
): Promise<boolean> {
  return gitRefTargetsBranchOnRemote(
    await getConfigValue(runGit, `branch.${branch}.base`),
    remote,
    branchRef
  )
}

function canPushConfiguredMergeBranch(
  pushRemote: ConfiguredPushRemote | null,
  branch: string,
  branchRef: string
): boolean {
  if (!pushRemote) {
    return false
  }
  if (branchRef === branch) {
    return true
  }
  // branch.merge belongs to branch.remote; pushDefault forks cannot inherit origin/main as their destination.
  return pushRemote.identity !== 'origin' && pushRemote.branchRemote === pushRemote.identity
}

type GitPushResolutionContext = {
  cwd: string
  scope?: string
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>
}

/** Resolve plain-push remote/refspec, or null for first publish (origin HEAD).
 * Share local/SSH routing: an incorrect destination cannot be repaired by retrying. */
export async function resolveConfiguredGitPushTarget(
  execGit: GitCommandRunner,
  context?: GitPushResolutionContext
): Promise<ResolvedGitPushTarget | null> {
  let config: GitConfigSnapshot | undefined
  const runGit = createGitConfigSnapshotRunner(async (args) => {
    const result = await execGit(args)
    if (args[0] === 'config' && args[1] === '--list') {
      config = parseGitConfigListSnapshot(result.stdout)
    }
    return result
  })
  const { stdout: branchStdout } = await runGit(['symbolic-ref', '--quiet', 'HEAD']).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 1) {
        return { stdout: '' }
      }
      throw error
    }
  )
  const branchRefName = branchStdout.trim()
  const branch = branchRefName.startsWith('refs/heads/') ? branchRefName.slice(11) : null
  if (!branch) {
    return null
  }
  const mergeRef = await getConfigValue(runGit, `branch.${branch}.merge`)
  const pushRemote = await getConfiguredPushRemote(
    runGit,
    branch,
    () => config,
    mergeRef ?? `refs/heads/${branch}`,
    context
  )
  const remote = pushRemote?.remote
  if (!remote || remote === '.') {
    return null
  }
  if (!mergeRef) {
    return { remote, refspec: 'HEAD' }
  }
  const branchRef = mergeRef.replace(/^refs\/heads\//, '')
  if (!branchRef || branchRef === mergeRef) {
    return null
  }
  if (await branchMergeTargetsConfiguredBase(runGit, branch, pushRemote.identity, branchRef)) {
    return null
  }
  if (!canPushConfiguredMergeBranch(pushRemote, branch, branchRef)) {
    return null
  }
  return { remote, refspec: `HEAD:${branchRef}` }
}
