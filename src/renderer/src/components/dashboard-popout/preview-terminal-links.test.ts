// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isMacPlatform } from '@/components/terminal-pane/terminal-link-open-hints'
import { installPreviewTerminalLinks } from './preview-terminal-links'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('opens OSC 8 hyperlinks on Mod+click instead of the xterm confirm prompt (#34229)', () => {
  const openUrl = vi.fn(async () => undefined)
  vi.stubGlobal('api', { shell: { openUrl } })
  const terminal = new Terminal()
  installPreviewTerminalLinks(terminal)
  const handler = terminal.options.linkHandler
  const url = 'https://github.com/stablyai/orca/pull/1'
  const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }

  handler?.activate(new MouseEvent('click', { button: 0 }), url, range)
  expect(openUrl).not.toHaveBeenCalled()

  const mac = isMacPlatform()
  const modClick = new MouseEvent('click', {
    button: 0,
    cancelable: true,
    metaKey: mac,
    ctrlKey: !mac
  })
  handler?.activate(modClick, url, range)
  expect(openUrl).toHaveBeenCalledWith(url)
  expect(modClick.defaultPrevented).toBe(true)
  terminal.dispose()
})
