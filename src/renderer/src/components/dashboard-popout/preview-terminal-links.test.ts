// @vitest-environment happy-dom
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { installPreviewTerminalLinks } from './preview-terminal-links'

describe('preview terminal links', () => {
  it('keeps CJK prose out of the real addon link and its browser target', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const register = vi.spyOn(terminal, 'registerLinkProvider')
    const clearSelection = vi.spyOn(terminal, 'clearSelection')
    const openUrl = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { shell: { openUrl } })
    const url = 'https://github.com/pingdotgg/t3code/issues/21106'
    try {
      installPreviewTerminalLinks(terminal)
      await new Promise<void>((resolve) => terminal.write(`${url}。现在不用你做事。`, resolve))
      const provider: ILinkProvider = register.mock.calls[0][0]
      const links = await new Promise<ILink[] | undefined>((resolve) =>
        provider.provideLinks(1, resolve)
      )
      expect(links).toHaveLength(1)
      expect(links?.[0].text).toBe(url)
      expect(links?.[0].range.end).toEqual({ x: url.length, y: 1 })
      const event = new MouseEvent('click', { metaKey: true, ctrlKey: true, cancelable: true })
      links?.[0].activate(event, links[0].text)
      expect(openUrl).toHaveBeenCalledWith(url)
      expect(event.defaultPrevented).toBe(true)
      expect(clearSelection).toHaveBeenCalledOnce()
    } finally {
      terminal.dispose()
      vi.unstubAllGlobals()
    }
  })
})
