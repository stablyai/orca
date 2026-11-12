import {
  readGitConfigSnapshot,
  type GitConfigSnapshot
} from '../commands/git-config-snapshot-runner'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import { parseGitRemoteVerboseLine } from './git-remote-url-index'

export type GitReviewBranchSource = {
  remoteName: string
  urls: string[]
  branchName: string
  /** A constrained publish destination; null leaves discovery usable without claiming a push head. */
  pushBranchName?: string | null
  trackedBranchName?: string
  trackedUrls?: string[]
}

type GitExec = (args: string[]) => Promise<{ stdout: string }>

function mappedPushBranch(spec: string, branch: string): string | null {
  const clean = spec.replace(/^\+/, '')
  if (clean === ':') {
    return branch
  }
  const [source, explicitDestination] = clean.split(':')
  const destination = explicitDestination ?? (source === 'HEAD' ? branch : source)
  if (!source) {
    return null
  }
  const normalized =
    source === 'HEAD'
      ? `refs/heads/${branch}`
      : source.startsWith('refs/')
        ? source
        : `refs/heads/${source}`
  const fullBranch = `refs/heads/${branch}`
  const star = normalized.indexOf('*')
  let target = destination
  if (star !== -1) {
    const prefix = normalized.slice(0, star)
    const suffix = normalized.slice(star + 1)
    if (!fullBranch.startsWith(prefix) || !fullBranch.endsWith(suffix)) {
      return null
    }
    target = destination.replace(
      '*',
      fullBranch.slice(prefix.length, fullBranch.length - suffix.length)
    )
  } else if (normalized !== fullBranch) {
    return null
  }
  if (
    !target ||
    target === 'HEAD' ||
    (target.startsWith('refs/') && !target.startsWith('refs/heads/'))
  ) {
    throw new Error('Review push destination is not a branch')
  }
  return target.replace(/^refs\/heads\//, '')
}

/** One repository snapshot supplies all branches, rather than probing configuration per lookup. */
export async function readGitReviewBranchSources(
  runGit: GitExec,
  branchNames: Iterable<string>
): Promise<Map<string, GitReviewBranchSource | Error>> {
  const config = await readGitConfigSnapshot(runGit)
  const { stdout } = await runGit(['remote', '-v'])
  const remotes = new Map<string, { fetch: string[]; push: string[] }>()
  for (const line of stdout.split(/\r?\n/)) {
    const entry = parseGitRemoteVerboseLine(line)
    if (!entry) {
      continue
    }
    const urls = remotes.get(entry.name) ?? { fetch: [], push: [] }
    urls[entry.direction].push(entry.url)
    remotes.set(entry.name, urls)
  }
  const get = (key: string): string | undefined => config.get(key)?.at(-1)?.trim() || undefined
  const remoteIdentities = new Map<string, string>()
  for (const [name, urls] of remotes) {
    for (const url of [...urls.fetch, ...(config.get(`remote.${name}.url`) ?? [])]) {
      if (!remoteIdentities.has(url)) {
        remoteIdentities.set(url, name)
      }
    }
  }
  const normalizeRemote = (remote: string): string => remoteIdentities.get(remote) ?? remote
  const expandedUrls = new Map<string, string[]>()
  const urlsFor = (remote: string): string[] => {
    const cached = expandedUrls.get(remote)
    if (cached) {
      return cached
    }
    const known = remotes.get(remote)
    const urls = known?.push.length ? known.push : known?.fetch
    const result =
      urls ??
      (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || /^[^\s/:]+@[^:]+:.+/.test(remote)
        ? [rewritePushUrl(config, remote)]
        : [])
    if (result.length === 0) {
      throw new Error('Review source remote is unavailable')
    }
    expandedUrls.set(remote, result)
    return result
  }
  const sources = new Map<string, GitReviewBranchSource | Error>()
  for (const branch of branchNames) {
    try {
      const trackedRemoteValue = get(`branch.${branch}.remote`)
      const trackedRemote = trackedRemoteValue ? normalizeRemote(trackedRemoteValue) : undefined
      const explicitRemote = get(`branch.${branch}.pushremote`) ?? get('remote.pushdefault')
      let remote = normalizeRemote(explicitRemote ?? trackedRemote ?? 'origin')
      const localTracking = remote === '.' && !explicitRemote
      if (localTracking) {
        remote = 'origin'
      }
      if (remote === '.') {
        throw new Error('Review publish remote is local')
      }
      const specs = config.get(`remote.${remote}.push`) ?? []
      let trackedBranchName: string | undefined
      const destinations = new Set(
        specs.map((spec) => mappedPushBranch(spec, branch)).filter((value) => value !== null)
      )
      if (destinations.size > 1) {
        throw new Error('Review push destination is ambiguous')
      }
      const branchName = destinations.values().next().value ?? branch
      let pushBranchName: string | null =
        destinations.size === 0 && (specs.length > 0 || get('push.default') === 'nothing')
          ? null
          : branchName
      if (destinations.size === 0) {
        if (!localTracking && remote === trackedRemote) {
          const merge = get(`branch.${branch}.merge`)
          const tracked = merge?.startsWith('refs/heads/')
            ? merge.slice('refs/heads/'.length)
            : undefined
          if (
            tracked &&
            tracked !== branch &&
            !gitRefTargetsBranchOnRemote(get(`branch.${branch}.base`), remote, tracked)
          ) {
            trackedBranchName = tracked
          }
          if ((get('push.default') ?? 'simple') === 'simple' && tracked && tracked !== branch) {
            pushBranchName = null
          }
          if (get('push.default') === 'upstream') {
            if (!merge) {
              throw new Error('Review upstream is unavailable')
            }
            pushBranchName = tracked ?? null
          }
        } else if (
          get('push.default') === 'upstream' &&
          explicitRemote &&
          remote !== trackedRemote
        ) {
          throw new Error('Review upstream belongs to another remote')
        }
      }
      sources.set(branch, {
        remoteName: remote,
        urls: urlsFor(remote),
        branchName,
        ...(pushBranchName !== branchName ? { pushBranchName } : {}),
        ...(trackedBranchName
          ? { trackedBranchName, trackedUrls: remotes.get(remote)?.fetch ?? [remote] }
          : {})
      })
    } catch {
      sources.set(branch, new Error('Cannot establish a unique hosted review source'))
    }
  }
  return sources
}

function rewritePushUrl(config: GitConfigSnapshot, url: string): string {
  for (const suffix of ['.pushinsteadof', '.insteadof']) {
    let match: { prefix: string; base: string } | undefined
    for (const [key, values] of config) {
      if (!key.startsWith('url.') || !key.endsWith(suffix)) {
        continue
      }
      for (const prefix of values) {
        if (url.startsWith(prefix) && (!match || prefix.length > match.prefix.length)) {
          match = { prefix, base: key.slice(4, -suffix.length) }
        }
      }
    }
    if (match) {
      return match.base + url.slice(match.prefix.length)
    }
  }
  return url
}
