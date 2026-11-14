import { describe, expect, it } from 'vitest'
import { gitLabJobTraceToLogExcerpt } from './gitlab-job-log-excerpt'

const CSI_ERASE = '\u001b[0K'
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
})
