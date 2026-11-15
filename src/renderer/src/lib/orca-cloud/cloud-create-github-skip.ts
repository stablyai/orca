// CREATE-GH-STEP: "Skip for now" on the create wizard's GitHub access step, remembered per
// repository on this device so the next create doesn't ask again. The step still shows (as
// skipped, with Set up), and the memory is dropped once the repository has access.
const STORAGE_KEY = 'orca.cloud-create.github-skip.v1'
const MAX_REPOS = 200

type SkipRecord = Record<string, number>

function key(repoUrl: string): string {
  return repoUrl.toLowerCase().replace(/\.git$/, '')
}

function read(): SkipRecord {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    )
  } catch {
    return {}
  }
}

function write(record: SkipRecord): void {
  try {
    const entries = Object.entries(record)
    if (entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    // Newest first, so a long-lived device keeps the repositories it still uses.
    const kept = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_REPOS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage unavailable or full: the step just asks again next time.
  }
}

export function isGitHubAccessSkipped(repoUrl: string): boolean {
  return read()[key(repoUrl)] !== undefined
}

export function rememberGitHubAccessSkip(repoUrl: string, now = Date.now()): void {
  write({ ...read(), [key(repoUrl)]: now })
}

export function forgetGitHubAccessSkip(repoUrl: string): void {
  const record = read()
  if (record[key(repoUrl)] === undefined) {
    return
  }
  delete record[key(repoUrl)]
  write(record)
}
