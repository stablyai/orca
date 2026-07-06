type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

type GitConfigSnapshot = Map<string, string[]>

// Why: mirror `git config --get`'s exit-1-on-absent-key so an intercepted miss
// rejects (matching real git) instead of resolving an empty success value.
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

function parseGitConfigListSnapshot(stdout: string): GitConfigSnapshot {
  const snapshot: GitConfigSnapshot = new Map()
  for (const record of stdout.split('\0')) {
    if (!record.trim()) {
      continue
    }

    // Why: config values may contain newlines, so only the first newline
    // separates git's emitted key from its value.
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
      // Why: upstream resolvers read config keys with Promise.all; the first
      // caller must publish the in-flight snapshot before any await.
      try {
        snapshotPromise = runGit(['config', '--list', '-z'])
          .then(({ stdout }) => {
            snapshot = parseGitConfigListSnapshot(stdout)
            return snapshot
          })
          .catch(() => {
            // Why: a snapshot failure should preserve existing real-git
            // behavior for this round instead of failing the config lookup.
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
      // Why: real `git config --get` exits non-zero for an absent key (it does
      // not return empty success), so reject here to stay a faithful drop-in —
      // callers branch on the rejection just as they would for real git.
      throw new GitConfigSnapshotKeyNotFoundError(key)
    }

    // Why: git config --get resolves multivar keys using the last occurrence.
    return { stdout: values.at(-1) ?? '' }
  }
}
