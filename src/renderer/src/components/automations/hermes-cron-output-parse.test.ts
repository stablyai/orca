import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHermesOutput } from './hermes-cron-output-parse'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseHermesOutput', () => {
  it('parses title, metadata, and structured sections', () => {
    const parsed = parseHermesOutput(
      [
        '# Cron Job: Nightly summary',
        '**Schedule:** 0 9 * * *',
        '**Run ID:** abc123',
        '',
        '## Response',
        'Done',
        '',
        '## Prompt',
        'Summarize work'
      ].join('\n')
    )

    expect(parsed.title).toBe('Nightly summary')
    expect(parsed.metadata).toEqual([
      { label: 'Schedule', value: '0 9 * * *' },
      { label: 'Run ID', value: 'abc123' }
    ])
    expect(parsed.sections).toEqual([
      { heading: 'Response', level: 2, body: 'Done' },
      { heading: 'Prompt', level: 2, body: 'Summarize work' }
    ])
  })

  it('normalizes CRLF section bodies without retaining carriage returns', () => {
    const parsed = parseHermesOutput('# Cron Job: X\r\n\r\n## Response\r\none\r\ntwo\r\n')

    expect(parsed.sections[0]?.body).toBe('one\ntwo')
  })

  it('parses newline-heavy structured output without splitting the full content', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const body = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`).join('\n')
    const content = `# Cron Job: X\n\n## Response\n${body}\n`

    const parsed = parseHermesOutput(content)

    expect(parsed.sections[0]?.heading).toBe('Response')
    expect(parsed.sections[0]?.body.startsWith('line 1\nline 2')).toBe(true)
    expect(parsed.sections[0]?.body.endsWith('line 10000')).toBe(true)
    expect(split).not.toHaveBeenCalled()
  })

  it('normalizes CRLF-heavy section bodies without a global replace pass', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const body = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`).join('\r\n')
    const content = `# Cron Job: X\r\n\r\n## Response\r\n${body}\r\n`

    const parsed = parseHermesOutput(content)

    expect(parsed.sections[0]?.body.startsWith('line 1\nline 2')).toBe(true)
    expect(parsed.sections[0]?.body.endsWith('line 10000')).toBe(true)
    const usedCrlfReplace = replace.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    expect(usedCrlfReplace).toBe(false)
  })
})
