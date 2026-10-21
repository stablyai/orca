// @vitest-environment happy-dom
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_WEB_LINK_URL_REGEX } from './terminal-web-link-url-regex'

const urlsIn = (line: string): string[] =>
  Array.from(line.matchAll(new RegExp(TERMINAL_WEB_LINK_URL_REGEX, 'gu')), (match) => match[0])

describe('terminal web-link URL boundaries', () => {
  it.each(['。', '，', '、', '）', '」', '→', '（', '【', '】', '　'])(
    'stops before %s and following CJK prose',
    (separator) => {
      expect(urlsIn(`https://example.com/文档${separator}现在不用你做事。`)).toEqual([
        'https://example.com/文档'
      ])
    }
  )

  it.each([
    'https://example.com/文档/路径',
    'http://localhost:5180/a_b-c?d=1&e=2#f',
    'HTTPS://example.com/a',
    'http://[::1]:5180/~user?q=a,b.c',
    'https://example.com/👩‍💻/tail'
  ])('keeps the URL %s intact', (url) => {
    expect(urlsIn(`see ${url} end`)).toEqual([url])
  })

  it.each(['.', ',', '!', '?', ':', ')', ']', '}', '>', '"', "'", '`'])(
    'still trims ASCII trailing %s',
    (suffix) => {
      expect(urlsIn(`https://example.com/a${suffix}`)).toEqual(['https://example.com/a'])
    }
  )

  it('finds multiple links independently', () => {
    expect(urlsIn('https://example.com/a。中文 https://example.com/b，続き')).toEqual([
      'https://example.com/a',
      'https://example.com/b'
    ])
  })

  it('keeps Unicode boundaries and emoji when the real addon clones the regex for wrapped lines', async () => {
    const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    const register = vi.spyOn(terminal, 'registerLinkProvider')
    const activate = vi.fn()
    terminal.loadAddon(new WebLinksAddon(activate, { urlRegex: TERMINAL_WEB_LINK_URL_REGEX }))
    const url = `https://example.com/${'a'.repeat(20)}/文档/👩‍💻/tail`
    try {
      await new Promise<void>((resolve) => terminal.write(`${url}。现在不用你做事。`, resolve))
      const provider: ILinkProvider = register.mock.calls[0][0]
      const links = await new Promise<ILink[] | undefined>((resolve) =>
        provider.provideLinks(1, resolve)
      )
      expect(links).toHaveLength(1)
      expect(links?.[0].text).toBe(url)
      const event = new MouseEvent('click')
      links?.[0].activate(event, links[0].text)
      expect(activate).toHaveBeenCalledWith(event, url)
    } finally {
      terminal.dispose()
    }
  })
})
