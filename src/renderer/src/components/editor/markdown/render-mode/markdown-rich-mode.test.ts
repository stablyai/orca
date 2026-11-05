import { afterEach, describe, expect, it, vi } from 'vitest'
import * as roundTrip from './markdown-round-trip'

import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../../../shared/constants'
import {
  getMarkdownRichModeEligibility,
  getMarkdownRichModeEligibilityDecision,
  getMarkdownRichModeUnsupportedMessage
} from './markdown-rich-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getMarkdownRichModeUnsupportedMessage', () => {
  it('allows large documents with source-preserving html without creating an editor', () => {
    const prefix = 'a'.repeat(50_001)
    const roundTripSpy = vi.spyOn(roundTrip, 'getRichMarkdownRoundTripOutput')

    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<span>text</span>\n`)).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<id>text</id>\n`)).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<Widget />\n`)).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<project-id value="1">\n`)).toBeNull()
    expect(roundTripSpy).not.toHaveBeenCalled()
  })

  it('still blocks large editable html that requires a round trip', () => {
    const content = `${'a'.repeat(50_001)}\n\n<details>\n<summary>Toggle</summary>\n\nBody\n\n</details>\n`
    const roundTripSpy = vi.spyOn(roundTrip, 'getRichMarkdownRoundTripOutput')

    expect(getMarkdownRichModeUnsupportedMessage(content)).not.toBeNull()
    expect(roundTripSpy).not.toHaveBeenCalled()
  })

  it('falls back safely when large markup cannot be encoded', () => {
    const content = `${'a'.repeat(50_001)}\n<span title="\ud800">text</span>`
    expect(getMarkdownRichModeUnsupportedMessage(content)).not.toBeNull()
  })

  it('strips newline-heavy fenced code without splitting the full body', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = `${'```tsx\n<Widget />\n```\n'.repeat(10_000)}# Tail\n`

    expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()

    expect(split).not.toHaveBeenCalled()
  })

  it('preserves newline-heavy embedded html without global fragment matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const content = `${'<span>hi</span>\n'.repeat(1_000)}Tail\n`

    expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()

    const usedGlobalHtmlFragmentMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.global &&
        pattern.source.startsWith('<!--[\\s\\S]*?-->')
    )
    expect(usedGlobalHtmlFragmentMatch).toBe(false)
  })

  it('keeps unsupported content blocked when it also exceeds the size limit', () => {
    const content = `${'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)}\n\n[ref]: https://example.com\n`

    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: false })).toEqual({
      exceedsSizeLimit: true,
      unsupportedMessage: expect.any(String)
    })
    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: true })).toEqual({
      exceedsSizeLimit: false,
      unsupportedMessage: expect.any(String)
    })
  })
})

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
})
