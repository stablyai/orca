// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isMacPlatform } from '@/components/terminal-pane/terminal-link-open-hints'
import { installPreviewTerminalLinks } from './preview-terminal-links'

const openUrl = vi.fn(async () => {})
const range = { start: { x: 1, y: 1 }, end: { x: 40, y: 1 } }
let terminal: Terminal

beforeEach(() => {
  openUrl.mockClear()
  Object.assign(window, { api: { shell: { openUrl } } })
  terminal = new Terminal()
})

afterEach(() => {
  terminal.dispose()
  vi.unstubAllGlobals()
})

it('opens OSC 8 hyperlinks externally on Mod+click instead of xterm’s confirm dialog', () => {
  const confirm = vi.fn(() => false)
  vi.stubGlobal('confirm', confirm)
  installPreviewTerminalLinks(terminal)
  const handler = terminal.options.linkHandler
  const url = 'https://github.com/stablyai/orca/pull/1'

  expect(handler).toBeTruthy()
  expect(handler?.allowNonHttpProtocols).toBeFalsy()
  handler?.activate(new MouseEvent('click', { cancelable: true }), url, range)
  expect(openUrl).not.toHaveBeenCalled()

  const modClick = new MouseEvent('click', {
    cancelable: true,
    ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true })
  })
  handler?.activate(modClick, url, range)
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
  expect(modClick.defaultPrevented).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})
