import { describe, expect, it, vi } from 'vitest'
import { getMarkdownRichModeEligibilityDecision } from './markdown-rich-mode'

const decide = (content: string) =>
  getMarkdownRichModeEligibilityDecision({ content, sizeOverridden: false })

describe('rich Markdown line scanning', () => {
  it('does not inspect every prose character to find newline boundaries', () => {
    const content = 'Ordinary prose '.repeat(10_000)
    const spy = vi.spyOn(String.prototype, 'charCodeAt')
    let decision: ReturnType<typeof decide>
    let calls: number
    try {
      decision = decide(content)
      calls = spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
    expect(decision).toEqual({ exceedsSizeLimit: false, unsupportedReason: null })
    expect(calls).toBeLessThan(10)
  })

  it.each(['\n', '\r\n'])(
    'preserves fences and reference visibility with %j endings',
    (newline) => {
      for (const fence of ['```', '~~~']) {
        const protectedSource = [`${fence}md`, '[ref]: /hidden', fence].join(newline)
        expect(decide(protectedSource).unsupportedReason).toBeNull()
        expect(decide(protectedSource + newline).unsupportedReason).toBeNull()
        expect(decide(`${protectedSource}${newline}[ref]: /visible`).unsupportedReason).toBe(
          'reference-links'
        )
      }
    }
  )

  it.each(['', '\n', '\r', '\r\n', '`[ref]: /hidden`', '```\n[ref]: /hidden\r'])(
    'preserves empty, final-CR, inline-code and unclosed-fence input %j',
    (content) => expect(decide(content).unsupportedReason).toBeNull()
  )
})
