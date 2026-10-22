import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { formatAgentImagePath, getAgentImageHandling } from './agent-image-paste'

describe('Muse image attachments', () => {
  it('pastes the raw path so the TUI attaches it like Claude and Codex', () => {
    expect(getAgentImageHandling('muse')).toBe('attachment')
    expect(formatAgentImagePath('muse', '/tmp/red8.png')).toBe('/tmp/red8.png')
    expect(formatAgentImagePath('codex', '/tmp/red8.png')).toBe('/tmp/red8.png')
  })

  it('still falls back to a file mention for agents without image paste', () => {
    expect(getAgentImageHandling('some-other-agent')).toBe('unsupported')
    expect(formatAgentImagePath('some-other-agent', '/tmp/red8.png')).toBe('@/tmp/red8.png')
  })
})

describe('OMP image references', () => {
  it.each([
    ['/tmp/screen@2x.png', '@"/tmp/screen@2x.png"'],
    ['/tmp/a "quote".png', `@'/tmp/a "quote".png'`],
    ["/tmp/a 'quote'.png", `@"/tmp/a 'quote'.png"`],
    ['C:\\Images\\screen shot.png', '@"C:\\Images\\screen shot.png"']
  ])('quotes %s for file-mention parsing', (path, expected) => {
    expect(formatAgentImagePath('omp', path)).toBe(expected)
    expect(formatAgentImagePath('claude', path)).toBe(path)
  })

  it.each([
    `/tmp/a "both' quotes.png`,
    `/tmp/a "both' quotes/image.png`,
    `/tmp/a "both' @quotes#100%.png`,
    `/tmp/a "both' \\quotes.png`,
    `C:\\Images\\a "both' quotes.png`,
    `\\\\server\\share\\a "both' quotes.png`
  ])('round trips unquotable absolute paths through OMP file URLs: %s', (path) => {
    const mention = formatAgentImagePath('omp', path)
    const encodedPath = /^@"([^"]+)"$/.exec(mention)?.[1]
    expect(encodedPath).toBeDefined()
    expect(fileURLToPath(encodedPath!, { windows: !path.startsWith('/') })).toBe(path)
    expect(formatAgentImagePath('claude', path)).toBe(path)
  })
})
