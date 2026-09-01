import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitOperationProgress, GitSequencerStop } from './git-status-types'

// Reads the rebase state directory git leaves in .git during an in-flight
// rebase/cherry-pick. Every field is best-effort: absent means unknown, never
// zero, so a partially written (or partially readable) state degrades instead
// of reporting "step 0 of 0".

const SHA_PREFIX = /^[0-9a-f]{40}\s*/i

async function readTrimmed(filePath: string): Promise<string | undefined> {
  try {
    const trimmed = (await readFile(filePath, 'utf-8')).trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

/** Only a positive decimal integer counts; "0", "-1", "1.5" and "abc" are unknown. */
function parseStep(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined
  }
  const value = Number(raw)
  return value > 0 ? value : undefined
}

function parseHeadName(raw: string | undefined): string | undefined {
  // Why: git writes the literal "detached HEAD" when there is no branch to name.
  if (!raw || raw === 'detached HEAD') {
    return undefined
  }
  const stripped = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
  return stripped.length > 0 ? stripped : undefined
}

function parseFirstLine(raw: string | undefined): string | undefined {
  const first = raw?.split('\n', 1)[0]?.trim()
  return first && first.length > 0 ? first : undefined
}

function lastDoneLine(raw: string | undefined): string | undefined {
  const lines = (raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1)
}

function parseStoppedBy(doneLine: string | undefined): GitSequencerStop | undefined {
  const command = doneLine?.split(/\s+/, 1)[0]
  if (!command) {
    return undefined
  }
  if (command === 'edit' || command === 'break') {
    return command
  }
  // pick/squash/fixup/reword/merge/... all mean "was replaying a commit".
  return 'pick'
}

/** Subject off a todo line: `pick <sha> # subject`, with both the sha and the `# ` optional. */
function parseDoneSubject(doneLine: string | undefined): string | undefined {
  if (!doneLine) {
    return undefined
  }
  const subject = doneLine
    .replace(/^\S+\s*/, '')
    .replace(SHA_PREFIX, '')
    .replace(/^#\s*/, '')
    .trim()
  return subject.length > 0 ? subject : undefined
}

function compactProgress(progress: GitOperationProgress): GitOperationProgress | undefined {
  const populated = Object.entries(progress).filter(([, value]) => value !== undefined)
  return populated.length > 0 ? (Object.fromEntries(populated) as GitOperationProgress) : undefined
}

async function readRebaseMergeProgress(dir: string): Promise<GitOperationProgress | undefined> {
  const [msgnum, end, headName, onto, message, done] = await Promise.all(
    ['msgnum', 'end', 'head-name', 'onto', 'message', 'done'].map((name) =>
      readTrimmed(path.join(dir, name))
    )
  )
  const currentStep = parseStep(msgnum)
  const totalSteps = parseStep(end)
  const doneLine = lastDoneLine(done)
  return compactProgress({
    headName: parseHeadName(headName),
    onto,
    // Why: a lone step number would render as "step 3 of ?"; keep them all-or-nothing.
    ...(currentStep !== undefined && totalSteps !== undefined ? { currentStep, totalSteps } : {}),
    // `message` is absent while paused on a `break`, so fall back to the todo line.
    commitSubject: parseFirstLine(message) ?? parseDoneSubject(doneLine),
    stoppedBy: parseStoppedBy(doneLine)
  })
}

async function readRebaseApplyProgress(dir: string): Promise<GitOperationProgress | undefined> {
  const [next, last, headName, onto, finalCommit] = await Promise.all(
    ['next', 'last', 'head-name', 'onto', 'final-commit'].map((name) =>
      readTrimmed(path.join(dir, name))
    )
  )
  const currentStep = parseStep(next)
  const totalSteps = parseStep(last)
  return compactProgress({
    headName: parseHeadName(headName),
    onto,
    ...(currentStep !== undefined && totalSteps !== undefined ? { currentStep, totalSteps } : {}),
    commitSubject: parseFirstLine(finalCommit)
    // The am backend has no todo list: edit/break can't happen, so stoppedBy stays absent.
  })
}

/**
 * Never throws: an unreadable state directory yields undefined, and an
 * unreadable file just omits its field. `gitDir` must be the resolved .git dir
 * of the worktree, read on the host that owns it.
 */
export async function readGitRebaseProgress(
  gitDir: string
): Promise<GitOperationProgress | undefined> {
  // rebase-merge wins when both are present; an unreadable one is indistinguishable
  // from an absent one here, which is why the apply read is the fallback.
  return (
    (await readRebaseMergeProgress(path.join(gitDir, 'rebase-merge'))) ??
    (await readRebaseApplyProgress(path.join(gitDir, 'rebase-apply')))
  )
}
