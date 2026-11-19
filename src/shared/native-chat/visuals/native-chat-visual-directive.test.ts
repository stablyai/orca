import { describe, expect, it } from 'vitest'
import {
  isPendingNativeChatVisualDirectiveTail,
  parseNativeChatVisualDirectiveLine,
  parseNativeChatWebhookDirectiveLine,
  withoutNativeChatVisualDirectiveLines,
  withoutPendingNativeChatVisualDirectiveTail,
  withLegacyNativeChatIdeasAsList
} from './native-chat-visual-directive'

describe('parseNativeChatVisualDirectiveLine', () => {
  it('ignores unknown attributes but refuses a repeated one', () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" height="300"}')).toEqual(
      { file: 'a.html', title: null }
    )
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" file="b.html"}')
    ).toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" title="x" title="y"}')
    ).toBeNull()
  })

  it.each([
    ['missing file', '::orca-visual{title="T"}'],
    ['unclosed', '::orca-visual{file="a.html"'],
    ['text after the line', '::orca-visual{file="a.html"} see above'],
    ['text before the marker', 'Chart: ::orca-visual{file="a.html"}'],
    ['wrong case', '::Orca-Visual{file="a.html"}'],
    ['single quotes', "::orca-visual{file='a.html'}"],
    ['backslash', '::orca-visual{file="a.html" title="a\\b"}'],
    ['control character', '::orca-visual{file="a.html" title="a\u0007b"}'],
    ['attributes glued together', '::orca-visual{file="a.html"title="T"}'],
    ['uppercase key', '::orca-visual{FILE="a.html"}'],
    ['embedded newline', '::orca-visual{file="a.html"\ntitle="T"}'],
    ['three colons', ':::orca-visual{file="a.html"}']
  ])('refuses %s', (_name, line) => {
    expect(parseNativeChatVisualDirectiveLine(line)).toBeNull()
  })
})

describe('streaming tail', () => {
  it('drops only the pending final line', () => {
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\n::orca-visual{file="a')).toBe(
      'Intro\n'
    )
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-vis')).toBe('')
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\nMore text')).toBe('Intro\nMore text')
    // A finished line (followed by a newline) is no longer the tail.
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-visual{file="a.html"}\n')).toBe(
      '::orca-visual{file="a.html"}\n'
    )
  })
})

describe('withoutNativeChatVisualDirectiveLines', () => {
  const LINE = '::orca-visual{file="usage.html" title="Usage"}'

  it('keeps the line inside fenced code and anything that is not a whole directive line', () => {
    const fenced = `\`\`\`\n${LINE}\n\`\`\`\nafter`
    expect(withoutNativeChatVisualDirectiveLines(fenced)).toBe(fenced)
    const tilde = `~~~~\n${LINE}\n~~~\nstill code\n~~~~`
    expect(withoutNativeChatVisualDirectiveLines(tilde)).toBe(tilde)
    expect(withoutNativeChatVisualDirectiveLines(`> ${LINE}`)).toBe(`> ${LINE}`)
    expect(withoutNativeChatVisualDirectiveLines(`See ${LINE}`)).toBe(`See ${LINE}`)
  })

  it('follows CommonMark fence rules: no info string on a closer, no backtick in an opener', () => {
    // ```js inside a block does not close it, so the visual line is still code.
    const notClosed = `\`\`\`\n\`\`\`js\n${LINE}\n\`\`\``
    expect(withoutNativeChatVisualDirectiveLines(notClosed)).toBe(notClosed)
    // Inline triple backticks open no fence, so a later visual line is still dropped.
    expect(withoutNativeChatVisualDirectiveLines(`Use \`\`\`a\`\`\` inline\n${LINE}`)).toBe(
      'Use ```a``` inline'
    )
  })
})

describe('parseNativeChatWebhookDirectiveLine', () => {
  const LINE = '::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc"}'

  it('reads the hook id from a whole line', () => {
    expect(parseNativeChatWebhookDirectiveLine(LINE)).toEqual({ hookId: 'wh_7Kx2pQ9mT4vB8nLc' })
    expect(parseNativeChatWebhookDirectiveLine(`  ${LINE}  \r\n`)).toEqual({
      hookId: 'wh_7Kx2pQ9mT4vB8nLc'
    })
  })

  it.each([
    '::orca-webhook{hook="wh_short"}',
    '::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc/orcawh_key"}',
    '::orca-webhook{}',
    '::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc" hook="wh_7Kx2pQ9mT4vB8nLd"}',
    '::orca-visual{hook="wh_7Kx2pQ9mT4vB8nLc"}'
  ])('refuses %s', (line) => {
    expect(parseNativeChatWebhookDirectiveLine(line)).toBeNull()
  })

  it('is held while streaming and left out of plain text', () => {
    expect(isPendingNativeChatVisualDirectiveTail('::orca-web')).toBe(true)
    expect(isPendingNativeChatVisualDirectiveTail('::orca-webhook{hook="wh_7K')).toBe(true)
    expect(withoutNativeChatVisualDirectiveLines(`It’s live.\n\n${LINE}\n\nDone.`)).toBe(
      'It’s live.\n\nDone.'
    )
    expect(withoutNativeChatVisualDirectiveLines(`\`\`\`\n${LINE}\n\`\`\``)).toContain(LINE)
  })
})

describe('withLegacyNativeChatIdeasAsList', () => {
  it("lists an old transcript's idea lines by their text, leaving fenced code alone", () => {
    expect(
      withLegacyNativeChatIdeasAsList(
        'Pick one:\n::orca-idea{text="Watch my PRs in orca" app="github"}\n  ::orca-idea{text="Answer #eng questions" needs="slack"}\n```\n::orca-idea{text="x"}\n```'
      )
    ).toBe(
      'Pick one:\n- Watch my PRs in orca\n- Answer #eng questions\n```\n::orca-idea{text="x"}\n```'
    )
  })
})
