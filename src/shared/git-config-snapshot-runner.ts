import { iterateNulDelimitedFields } from './nul-delimited-fields'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export type GitConfigSnapshot = Map<string, string[]>

// Mirror config --get exit 1 for absent keys; empty success changes caller behavior.
export class GitConfigSnapshotKeyNotFoundError extends Error {
  constructor(key: string) {
    super(`git config --get found no value for '${key}'`)
    this.name = 'GitConfigSnapshotKeyNotFoundError'
  }
}

function isConfigGetCommand(args: string[]): boolean {
  return args.length === 3 && args[0] === 'config' && args[1] === '--get'
}

function canonicalizeGitConfigLookupKey(key: string): string {
  const parts = key.split('.')
  if (parts.length === 1) {
    return key.toLowerCase()
  }
  const firstPart = parts[0]?.toLowerCase() ?? ''
  const lastPart = parts.at(-1)?.toLowerCase() ?? ''
  return [firstPart, ...parts.slice(1, -1), lastPart].join('.')
}

export function parseGitConfigListSnapshot(stdout: string): GitConfigSnapshot {
  const snapshot: GitConfigSnapshot = new Map()
  for (const record of iterateNulDelimitedFields(stdout)) {
    if (!record.trim()) {
      continue
    }

    // Values may contain newlines; only the first separates key and value.
    const separatorIndex = record.indexOf('\n')
    const key = separatorIndex === -1 ? record : record.slice(0, separatorIndex)
    const value = separatorIndex === -1 ? '' : record.slice(separatorIndex + 1)
    const values = snapshot.get(key) ?? []
    values.push(value)
    snapshot.set(key, values)
  }
  return snapshot
}

export function createGitConfigSnapshotRunner(runGit: GitCommandRunner): GitCommandRunner {
  let snapshotPromise: Promise<GitConfigSnapshot | null> | null = null
  let snapshot: GitConfigSnapshot | null = null
  let interceptionDisabled = false

  const readSnapshot = (): Promise<GitConfigSnapshot | null> => {
    if (snapshot) {
      return Promise.resolve(snapshot)
    }
    if (!snapshotPromise) {
      // Publish the shared promise before any await so parallel resolvers coalesce.
      try {
        snapshotPromise = runGit(['config', '--list', '-z'])
          .then(({ stdout }) => {
            snapshot = parseGitConfigListSnapshot(stdout)
            return snapshot
          })
          .catch(() => {
            // Fall back to real Git this round if snapshot loading fails.
            interceptionDisabled = true
            snapshotPromise = null
            return null
          })
      } catch {
        interceptionDisabled = true
        snapshotPromise = null
        return Promise.resolve(null)
      }
    }
    return snapshotPromise
  }

  return async (args) => {
    if (interceptionDisabled || !isConfigGetCommand(args)) {
      return runGit(args)
    }

    const configSnapshot = await readSnapshot()
    if (!configSnapshot) {
      return runGit(args)
    }

    const key = args[2] ?? ''
    const values = configSnapshot.get(canonicalizeGitConfigLookupKey(key))
    if (!values?.length) {
      // Missing keys must reject like real config --get; callers branch on rejection.
      throw new GitConfigSnapshotKeyNotFoundError(key)
    }

    // Multivar reads use the last occurrence, matching config --get.
    return { stdout: values.at(-1) ?? '' }
  }
}

export function gitConfigBoolean(value: string | null | undefined): boolean {
  if (value === null) {
    return true
  }
  const normalized = value?.trim()
  return (
    normalized !== undefined &&
    (/^(true|yes|on)$/i.test(normalized) ||
      (/^[+-]?(?:0x[0-9a-f]+|[0-9]+)[kmg]?$/i.test(normalized) &&
        Number.parseInt(normalized, 0) !== 0))
  )
}

export function parseGitConfigOriginSnapshot(stdout: string) {
  const records = [...iterateNulDelimitedFields(stdout)]
  if (records.at(-1) === '') {
    records.pop()
  }
  if (records.length % 2) {
    throw new Error('Incomplete Git config origin output.')
  }
  const origins: { origin: string; key: string; value: string | null }[] = []
  const config: GitConfigSnapshot = new Map()
  const booleans = new Map<string, boolean>()
  for (let i = 0; i < records.length; i += 2) {
    const record = records[i + 1]
    const end = record.indexOf('\n')
    const key = canonicalizeGitConfigLookupKey(end === -1 ? record : record.slice(0, end))
    const value = end === -1 ? null : record.slice(end + 1)
    origins.push({ origin: records[i], key, value })
    booleans.set(key, gitConfigBoolean(value))
    const values = config.get(key) ?? []
    values.push(value ?? '')
    config.set(key, values)
  }
  return { config, origins, booleans }
}

export type GitLegacyEntryObservation = {
  name: string
  file: string
  target?: string
  contents?: string
  kind: 'file' | 'directory' | 'missing' | 'special' | 'unknown'
  error?: string
}

/** Own each config vector once; native row order and authority inputs remain unchanged. */
export function constructGitRemotePolicies(
  config: ReadonlyMap<string, readonly string[]>,
  stores: readonly (readonly GitLegacyEntryObservation[])[],
  selectedName?: string
) {
  const policy = new Map<string, Map<string, string[]>>()
  const names = new Set<string>()
  const legacy = new Set<string>()
  const fallback = new Set<string>()
  const uncertain = new Set<string>()
  const observe = new Set<string>()
  for (const [key, values] of config) {
    const match = /^remote\.(.+)\.([^.]+)$/.exec(key)
    if (!match || (selectedName !== undefined && match[1] !== selectedName)) {
      continue
    }
    const fields = policy.get(match[1]) ?? new Map<string, string[]>()
    fields.set(match[2], values.slice())
    policy.set(match[1], fields)
    names.add(match[1])
  }
  const remotes = new Map(
    (stores[0] ?? [])
      .filter((row) => selectedName === undefined || row.name === selectedName)
      .map((row) => [row.name, row])
  )
  const branches = new Map(
    (stores[1] ?? [])
      .filter((row) => selectedName === undefined || row.name === selectedName)
      .map((row) => [row.name, row])
  )
  const candidates = new Set([...policy.keys(), ...remotes.keys(), ...branches.keys()])
  const append = (fields: Map<string, string[]>, key: string, value: string) => {
    const values = fields.get(key)
    if (values) {
      values.push(value)
    } else {
      fields.set(key, [value])
    }
  }
  for (const name of candidates) {
    const fields = policy.get(name) ?? new Map<string, string[]>()
    if (fields.get('url')?.length || fields.get('vcs')?.length) {
      continue
    }
    const remote = remotes.get(name)
    const branch = branches.get(name)
    if (remote?.kind === 'file') {
      names.add(name)
      legacy.add(name)
      fallback.add(name)
      for (const line of remote.contents!.split('\n')) {
        const match = /^(URL|Push|Pull):\s*(.*)$/.exec(line.trimEnd())
        if (match) {
          append(
            fields,
            match[1] === 'URL' ? 'url' : match[1] === 'Push' ? 'push' : 'fetch',
            match[2]
          )
        }
      }
    } else if (remote && remote.kind !== 'missing') {
      observe.add(name)
      if (remote.kind !== 'directory') {
        uncertain.add(name)
      }
    } else if (remote?.error) {
      observe.add(name)
      uncertain.add(name)
    }
    if (!fields.get('url')?.length && !fields.get('vcs')?.length) {
      if (branch?.kind === 'file') {
        const value = branch.contents!.split('\n')[0].trim()
        if (value) {
          const hash = value.indexOf('#')
          const url = hash === -1 ? value : value.slice(0, hash)
          const head = hash === -1 ? 'master' : value.slice(hash + 1)
          append(fields, 'url', url)
          append(fields, 'fetch', `refs/heads/${head}:refs/heads/${name}`)
          append(fields, 'push', `HEAD:refs/heads/${head}`)
          fields.set('tagopt', ['--tags'])
          names.add(name)
          legacy.add(name)
          fallback.add(name)
        }
      } else if (branch && branch.kind !== 'missing') {
        observe.add(name)
        if (branch.kind !== 'directory') {
          uncertain.add(name)
        }
      } else if (branch?.error) {
        observe.add(name)
        uncertain.add(name)
      }
    }
    policy.set(name, fields)
  }
  return { policy, names, legacy, fallback, uncertain, observe }
}
