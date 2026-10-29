import { describe, expect, it } from 'vitest'
import { isMissingGitBlobPath } from './git-blob-absence'

describe('Git blob path absence', () => {
  it.each([
    { stderr: "fatal: path 'new.txt' exists on disk, but not in the index\n" },
    {
      stderr: Buffer.from(
        "fatal: Path 'new.txt' does not exist (neither on disk nor in the index).\n"
      )
    }
  ])('recognizes exact index absence across Git versions', ({ stderr }) => {
    expect(isMissingGitBlobPath({ code: 128, stderr }, 'new.txt')).toBe(true)
  })

  it.each([
    "fatal: path 'new.txt' does not exist in 'HEAD'\n",
    "fatal: Path 'new.txt' exists on disk, but not in 'HEAD'.\n"
  ])('recognizes exact tree path absence', (stderr) => {
    expect(isMissingGitBlobPath({ code: 128, stderr }, 'new.txt', 'HEAD')).toBe(true)
  })

  it.each([
    'fatal: bad object :new.txt',
    'fatal: invalid object name HEAD',
    'fatal: detected dubious ownership in repository',
    'fatal: bad config line 1',
    "fatal: path 'other.txt' does not exist (neither on disk nor in the index)",
    "fatal: path 'new.txt' is in the index, but not at stage 0"
  ])('does not classify another failure as absence (%s)', (stderr) => {
    expect(isMissingGitBlobPath({ code: 128, stderr }, 'new.txt')).toBe(false)
  })

  it('requires the exit status as well as the diagnostic', () => {
    const stderr = "fatal: path 'new.txt' exists on disk, but not in the index"
    expect(isMissingGitBlobPath({ code: 1, stderr }, 'new.txt')).toBe(false)
    expect(isMissingGitBlobPath({ code: '128', stderr }, 'new.txt')).toBe(false)
  })

  it('matches newline and quote filenames literally', () => {
    const filePath = "quote' and\nnewline.txt"
    const stderr = `fatal: path '${filePath}' exists on disk, but not in the index\n`
    expect(isMissingGitBlobPath({ code: 128, stderr }, filePath)).toBe(true)
    expect(
      isMissingGitBlobPath({ code: 128, stderr: `fatal: bad object :${filePath}` }, filePath)
    ).toBe(false)
  })
})
