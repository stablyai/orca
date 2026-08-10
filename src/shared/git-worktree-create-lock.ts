import { posix, win32 } from 'node:path'

const createLockTails = new Map<string, Promise<void>>()

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizePath(value: string): string {
  if (process.platform === 'win32' || looksLikeWindowsPath(value)) {
    return win32.resolve(value).toLowerCase()
  }
  return posix.resolve(value)
}

function createLockKeys(repoPath: string, branchName: string, targetDir: string): string[] {
  const repo = normalizePath(repoPath)
  const branch = branchName.replace(/^refs\/heads\//, '')
  return [`${repo}\0branch\0${branch}`, `${repo}\0target\0${normalizePath(targetDir)}`].sort()
}

async function acquireCreateLock(key: string): Promise<() => void> {
  const previous = createLockTails.get(key) ?? Promise.resolve()
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  createLockTails.set(key, tail)
  await previous.catch(() => {})

  return () => {
    releaseGate()
    if (createLockTails.get(key) === tail) {
      createLockTails.delete(key)
    }
  }
}

export async function withGitWorktreeCreateLock<T>(
  repoPath: string,
  branchName: string,
  targetDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const releases: (() => void)[] = []
  try {
    for (const key of createLockKeys(repoPath, branchName, targetDir)) {
      releases.push(await acquireCreateLock(key))
    }
    return await operation()
  } finally {
    for (const release of releases.toReversed()) {
      release()
    }
  }
}

export function resetGitWorktreeCreateLocksForTests(): void {
  createLockTails.clear()
}
