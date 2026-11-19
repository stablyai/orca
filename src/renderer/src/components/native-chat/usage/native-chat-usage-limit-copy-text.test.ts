import { describe, expect, it } from 'vitest'
import { USAGE_LIMIT_COPY_CAP, usageLimitCopyText } from './native-chat-usage-limit-copy-text'

const NOTE = 'COPY_SHORTENED'
const frame = (head: string, truncatedNote?: string) => ({
  provider: 'codex',
  summary: 'notification:error',
  head,
  ...(truncatedNote ? { truncatedNote } : {})
})

describe('usageLimitCopyText', () => {
  it('keeps the frame identity and provider truncation when the detail and head are huge', () => {
    const copied = usageLimitCopyText({
      sentence: 'S.',
      detail: 'd'.repeat(200_000),
      frame: frame('h'.repeat(200_000), 'PROVIDER_TRUNCATED'),
      copyNote: NOTE
    })
    expect(copied.length).toBeLessThanOrEqual(USAGE_LIMIT_COPY_CAP)
    expect(copied).toContain('codex · notification:error\nh')
    expect(copied).toContain('…\nPROVIDER_TRUNCATED')
    expect(copied.endsWith(NOTE)).toBe(true)
    expect(copied.split('d').length - 1).toBeGreaterThan(30_000)
    expect(copied.split('h').length - 1).toBeGreaterThan(30_000)
  })

  it('gives a short detail all it needs and the rest to the head', () => {
    const copied = usageLimitCopyText({
      sentence: 'S.',
      detail: 'short detail',
      frame: frame('h'.repeat(200_000)),
      copyNote: NOTE
    })
    expect(copied).toContain('\n\nshort detail\n\n')
    expect(copied.length).toBeGreaterThan(USAGE_LIMIT_COPY_CAP - 100)
    expect(copied.length).toBeLessThanOrEqual(USAGE_LIMIT_COPY_CAP)
  })

  it('bounds oversized fixed fields, keeping the provider recognizable and saying the copy was cut', () => {
    const copied = usageLimitCopyText({
      sentence: 's'.repeat(100_000),
      frame: {
        provider: `codex${'p'.repeat(10_000)}`,
        summary: 'k'.repeat(10_000),
        head: 'H',
        truncatedNote: 'n'.repeat(10_000)
      },
      copyNote: `${NOTE}${'c'.repeat(10_000)}`
    })
    expect(copied.length).toBeLessThanOrEqual(USAGE_LIMIT_COPY_CAP)
    expect(copied).toContain('\n\ncodexp')
    expect(copied).toContain(`\n\n${NOTE}`)
  })

  it('never splits a surrogate pair when cutting', () => {
    const copied = usageLimitCopyText({
      sentence: 'S.',
      detail: '😀'.repeat(USAGE_LIMIT_COPY_CAP),
      copyNote: NOTE
    })
    expect(copied.length).toBeLessThanOrEqual(USAGE_LIMIT_COPY_CAP)
    expect(copied).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
