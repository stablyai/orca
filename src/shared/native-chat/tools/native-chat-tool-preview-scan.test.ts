import { describe, expect, it, vi } from 'vitest'
import { createToolInputDisplay, summarizeToolInput } from './native-chat-tool-summary'

const originalSummary = (input: string): string => {
  const collapsed = input.replace(/\s+/g, ' ').trim()
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`
}

describe('bounded tool preview whitespace normalization', () => {
  it('avoids whole-input replacement for long prose previews', () => {
    const input = 'a   b\n\t'.repeat(20_000)
    const spy = vi.spyOn(String.prototype, 'replace')
    let fullReplacements: number
    let display: ReturnType<typeof createToolInputDisplay>
    try {
      display = createToolInputDisplay(input)
      fullReplacements = spy.mock.instances.filter((receiver) => String(receiver) === input).length
    } finally {
      spy.mockRestore()
    }
    expect(display.label).toBe(originalSummary(input))
    expect(display.hasDetail).toBe(true)
    expect(fullReplacements).toBe(0)
  })

  it('preserves exact labels and detail flags across whitespace and UTF-16 boundaries', () => {
    const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    const inputs = [
      '',
      whitespace.repeat(50),
      `${'x'.repeat(79)}…`,
      '😀'.repeat(41),
      '\ud800'.repeat(82),
      '\u0085\u200b'.repeat(50)
    ]
    for (const length of [0, 1, 78, 79, 80, 81, 159, 160, 161]) {
      inputs.push(`${whitespace}${'x'.repeat(length)}${whitespace.repeat(30)}`)
      inputs.push(`${'x'.repeat(length)}${whitespace}tail`)
    }
    for (const input of inputs) {
      const expected = originalSummary(input)
      const display = createToolInputDisplay(input)
      expect(summarizeToolInput(input)).toBe(expected)
      expect(display.label).toBe(expected)
      expect(display.hasDetail).toBe(input.replace(/\s+/g, ' ').trim() !== expected)
      expect(display.formatDetail()).toBe(input.length > 4000 ? `${input.slice(0, 4000)}…` : input)
    }
  })
})
