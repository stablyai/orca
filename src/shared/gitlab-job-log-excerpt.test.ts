import { describe, expect, it } from 'vitest'
import { gitLabJobTraceToLogExcerpt, toGitLabJobLogExcerptResult } from './gitlab-job-log-excerpt'
import { PR_CHECK_LOG_TAIL_BYTES } from './check-job-log-tail-slice'

const CSI_ERASE = '\u001b[0K'
const RESET = '\u001b[0;m'
const CR = '\r'

describe('gitLabJobTraceToLogExcerpt', () => {
  it('keeps the visible header of a section marker and drops the marker itself', () => {
    const trace = [
      `section_start:1699000000:build_script${CR}${CSI_ERASE}$ pnpm build`,
      'built in 3s',
      `section_end:1699000030:build_script${CR}${CSI_ERASE}`
    ].join('\n')

    const excerpt = gitLabJobTraceToLogExcerpt(trace)

    expect(excerpt).toContain('$ pnpm build')
    expect(excerpt).toContain('built in 3s')
    expect(excerpt).not.toContain('section_start')
    expect(excerpt).not.toContain('section_end')
  })

  it('strips ANSI colour sequences', () => {
    const excerpt = gitLabJobTraceToLogExcerpt(`${RESET}ERROR: Job failed${RESET}`)

    expect(excerpt).toBe('ERROR: Job failed')
    expect(excerpt).not.toContain('[0;m')
  })

  it('splits carriage-return progress output so the line tail still applies', () => {
    const progress = Array.from({ length: 5_000 }, (_, index) => `downloading ${index}%`).join('\r')

    const excerpt = gitLabJobTraceToLogExcerpt(`${progress}\nERROR: Job failed: exit code 1`)

    expect(excerpt).toContain('ERROR: Job failed: exit code 1')
    expect(excerpt).not.toContain('downloading 0%')
    expect(excerpt.length).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('bounds a multi-megabyte trace below the 1 MB runtime transport frame cap', () => {
    const huge = Array.from(
      { length: 60_000 },
      (_, index) => `line ${index} ${'x'.repeat(60)}`
    ).join('\n')

    const excerpt = gitLabJobTraceToLogExcerpt(huge)

    expect(huge.length).toBeGreaterThan(1024 * 1024)
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
    expect(excerpt).toContain('line 59999')
  })

  it('preserves earlier error context buried under trailing noise', () => {
    const trace = [
      ...Array.from({ length: 150 }, (_, index) => `Installing package ${index}`),
      'ERROR: Job failed: exit code 1',
      ...Array.from({ length: 90 }, (_, index) => `Uploading artifact ${index}`)
    ].join('\n')

    const excerpt = gitLabJobTraceToLogExcerpt(trace)

    expect(excerpt).toContain('ERROR: Job failed: exit code 1')
    expect(excerpt).toContain('Uploading artifact 89')
  })

  it('bounds the raw trace before stripping so a huge log is not scanned in full', () => {
    const filler = `${'x'.repeat(200)}\n`.repeat(6_000) // ~1.2 MB, above the raw cap
    const excerpt = gitLabJobTraceToLogExcerpt(`head marker\n${filler}ERROR: Job failed`)

    expect(excerpt).toContain('ERROR: Job failed')
    expect(excerpt).not.toContain('head marker')
  })

  it('returns an empty excerpt for a job that never produced a log', () => {
    expect(gitLabJobTraceToLogExcerpt('')).toBe('')
    expect(gitLabJobTraceToLogExcerpt(`   \n${CSI_ERASE}\n  `)).toBe('')
  })
})

describe('toGitLabJobLogExcerptResult', () => {
  it('bounds a successful trace and passes errors through untouched', () => {
    const bounded = toGitLabJobLogExcerptResult({ ok: true, trace: `${RESET}done` })
    expect(bounded).toEqual({ ok: true, trace: 'done' })

    const failure = { ok: false, error: '403 Forbidden' } as const
    expect(toGitLabJobLogExcerptResult(failure)).toBe(failure)
  })
})
