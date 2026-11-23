import { describe, expect, it } from 'vitest'
import { remarkedBotMemoryLine } from './bot-memory-remark'

const FROM = ' · from: '

describe('remarkedBotMemoryLine', () => {
  it('keeps a line with no source and no mark byte for byte', () => {
    expect(remarkedBotMemoryLine('*  a  b\t ', null, null, FROM)).toBe('*  a  b\t ')
  })

  it('marks a line, keeping every other byte', () => {
    expect(remarkedBotMemoryLine('-  2026-11-01:  a  b  ', null, 'Slack', FROM)).toBe(
      '-  2026-11-01:  a  b · from: Slack'
    )
  })

  it('swaps the source the line claims, however it is spaced, or drops it', () => {
    const raw = '- a  b ·   from:  x · from:   Slack, Bob  '
    expect(remarkedBotMemoryLine(raw, 'Slack, Bob', 'Webhook', FROM)).toBe(
      '- a  b ·   from:  x · from: Webhook'
    )
    expect(remarkedBotMemoryLine(raw, 'Slack, Bob', null, FROM)).toBe('- a  b ·   from:  x')
  })

  it('takes time linear in the line, however it is spaced', () => {
    const raw = `- ${' ·'.repeat(500_000)}${' '.repeat(500_000)}${FROM}${' '.repeat(500_000)}s`
    const started = performance.now()
    const line = remarkedBotMemoryLine(raw, 's', 'm', FROM)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(line).toBe(`- ${' ·'.repeat(500_000)}${FROM}m`)
  })
})
