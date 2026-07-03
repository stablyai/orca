import type { CreateInitialCommitResult } from './types'

export type GitExec = (argv: string[]) => Promise<{ stdout: string }>

const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]

export const GIT_IDENTITY_ERROR_PATTERN = /Please tell me who you are|user\.name|user\.email/i

export const GIT_IDENTITY_GUIDANCE_MESSAGE =
  'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'

const EMPTY_TREE_OIDS = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
} as const

function getGitErrorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr
    // Why: provider.exec (SSH) errors may carry the git diagnostic only in
    // stderr, while local execFile folds it into the message.
    return typeof stderr === 'string' && stderr.trim().length > 0
      ? `${error.message}\n${stderr}`
      : error.message
  }
  return String(error)
}

async function execStdout(exec: GitExec, argv: string[]): Promise<string> {
  const { stdout } = await exec(argv)
  return stdout.trim()
}

async function tryExecStdout(exec: GitExec, argv: string[]): Promise<string | null> {
  try {
    return await execStdout(exec, argv)
  } catch {
    return null
  }
}

async function resolveDefaultBaseRefViaExec(exec: GitExec): Promise<string | null> {
  const originHead = await tryExecStdout(exec, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD'
  ])
  if (originHead) {
    const resolved = await tryExecStdout(exec, [
      'rev-parse',
      '--quiet',
      '--verify',
      `${originHead}^{commit}`
    ])
    // Why: origin/HEAD can be a stale symref; the initial-commit guard should
    // only no-op when the target is a real commit.
    if (resolved) {
      return originHead.replace(/^refs\/remotes\//, '')
    }
  }
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    const exists = await tryExecStdout(exec, [
      'rev-parse',
      '--quiet',
      '--verify',
      `${ref}^{commit}`
    ])
    if (exists) {
      return returnAs
    }
  }
  return null
}

async function resolveExistingHeadBaseRef(exec: GitExec): Promise<string | null> {
  const symbolic = await tryExecStdout(exec, ['symbolic-ref', '--short', 'HEAD'])
  if (symbolic) {
    return symbolic
  }
  return tryExecStdout(exec, ['rev-parse', 'HEAD'])
}

async function firstShortRef(
  exec: GitExec,
  namespace: string,
  excludes: readonly string[] = []
): Promise<string | null> {
  const stdout = await tryExecStdout(exec, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname:short)',
    ...excludes.map((pattern) => `--exclude=${pattern}`),
    namespace
  ])
  return (
    stdout
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

async function resolveAnyExistingBranchRef(exec: GitExec): Promise<string | null> {
  const headBranch = await tryExecStdout(exec, ['symbolic-ref', '--short', 'HEAD'])
  if (
    headBranch &&
    (await tryExecStdout(exec, [
      'rev-parse',
      '--quiet',
      '--verify',
      `refs/heads/${headBranch}^{commit}`
    ]))
  ) {
    return headBranch
  }
  const localBranch = await firstShortRef(exec, 'refs/heads')
  if (localBranch) {
    return localBranch
  }
  return firstShortRef(exec, 'refs/remotes', ['refs/remotes/*/HEAD'])
}

async function resolveExistingBaseRef(exec: GitExec): Promise<string | null> {
  const resolved = await resolveDefaultBaseRefViaExec(exec)
  if (resolved) {
    return resolved
  }
  const headCommit = await tryExecStdout(exec, [
    'rev-parse',
    '--quiet',
    '--verify',
    'HEAD^{commit}'
  ])
  if (headCommit) {
    return resolveExistingHeadBaseRef(exec)
  }
  // Why: bare/unborn repos can have commits on a non-HEAD branch; creating an
  // empty HEAD commit would hide the branch the user actually needs to resume.
  return resolveAnyExistingBranchRef(exec)
}

async function resolveObjectFormat(exec: GitExec): Promise<'sha1' | 'sha256'> {
  const format = await tryExecStdout(exec, ['rev-parse', '--show-object-format'])
  return format === 'sha256' ? 'sha256' : 'sha1'
}

async function createPlumbingInitialCommit(exec: GitExec): Promise<CreateInitialCommitResult> {
  const headRef = await tryExecStdout(exec, ['symbolic-ref', 'HEAD'])
  const branchRef = headRef?.startsWith('refs/heads/') ? headRef : 'refs/heads/main'
  const objectFormat = await resolveObjectFormat(exec)
  const emptyTreeOid = EMPTY_TREE_OIDS[objectFormat]
  const zeroOid = '0'.repeat(objectFormat === 'sha256' ? 64 : 40)
  // Why: plumbing avoids touching the index or working tree; `commit
  // --allow-empty` can accidentally commit staged files in an unborn repo.
  const sha = await execStdout(exec, ['commit-tree', emptyTreeOid, '-m', 'Initial commit'])
  try {
    // Why: compare-and-swap create (old value = zero OID) prevents clobbering
    // a ref that appeared between the guards and write.
    await exec(['update-ref', branchRef, sha, zeroOid])
  } catch {
    const raced = await resolveExistingBaseRef(exec)
    if (raced) {
      return { ok: true, baseRef: raced }
    }
    return { ok: false, error: `Failed to create branch ${branchRef} for the initial commit.` }
  }
  return { ok: true, baseRef: branchRef.replace(/^refs\/heads\//, '') }
}

export async function createInitialCommit(exec: GitExec): Promise<CreateInitialCommitResult> {
  try {
    const existing = await resolveExistingBaseRef(exec)
    if (existing) {
      return { ok: true, baseRef: existing }
    }
    return await createPlumbingInitialCommit(exec)
  } catch (error) {
    const text = getGitErrorText(error)
    if (GIT_IDENTITY_ERROR_PATTERN.test(text)) {
      return { ok: false, error: GIT_IDENTITY_GUIDANCE_MESSAGE }
    }
    return { ok: false, error: `Failed to create initial commit: ${text}` }
  }
}

const inFlightByRepoId = new Map<string, Promise<CreateInitialCommitResult>>()

export async function createInitialCommitSerialized(
  repoId: string,
  exec: GitExec
): Promise<CreateInitialCommitResult> {
  const existing = inFlightByRepoId.get(repoId)
  if (existing) {
    return existing
  }
  const promise = createInitialCommit(exec).finally(() => {
    if (inFlightByRepoId.get(repoId) === promise) {
      inFlightByRepoId.delete(repoId)
    }
  })
  inFlightByRepoId.set(repoId, promise)
  return promise
}
