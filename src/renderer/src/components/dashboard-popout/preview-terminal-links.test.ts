import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { WebLinksAddonMock } = vi.hoisted(() => ({
  WebLinksAddonMock: vi.fn()
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: WebLinksAddonMock
}))

vi.mock('@/lib/pane-manager/terminal-link-provider-guard', () => ({
  installGuardedLinkProviderRegistration: vi.fn()
}))

import { installPreviewTerminalLinks } from './preview-terminal-links'

const openUrlMock = vi.fn()

function previewLinkHandler(): (event: MouseEvent, uri: string) => void {
  const terminal = {
    loadAddon: vi.fn(),
    clearSelection: vi.fn()
  }
  installPreviewTerminalLinks(terminal as never)
  const handler = WebLinksAddonMock.mock.calls.at(-1)?.[0] as
    | ((event: MouseEvent, uri: string) => void)
    | undefined
  if (!handler) {
    throw new Error('Expected WebLinksAddon handler')
  }
  return handler
}

function mouseEvent(init: Partial<MouseEvent>): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...init
  } as MouseEvent
}

describe('installPreviewTerminalLinks custom schemes', () => {
  beforeEach(() => {
    WebLinksAddonMock.mockClear()
    openUrlMock.mockReset()
    openUrlMock.mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not hand off a custom app URL on a plain click', () => {
    previewLinkHandler()(mouseEvent({}), 'obsidian://open?vault=notes')
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('does not hand off a custom app URL on the wrong platform modifier', () => {
    previewLinkHandler()(mouseEvent({ ctrlKey: true }), 'obsidian://open?vault=notes')
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens custom app schemes with ⌘+click on Mac', () => {
    previewLinkHandler()(mouseEvent({ metaKey: true }), 'obsidian://open?vault=notes')
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('obsidian://open?vault=notes')
  })

  it('opens custom app schemes with Ctrl+click on non-Mac', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
    previewLinkHandler()(mouseEvent({ ctrlKey: true }), 'obsidian://open?vault=notes')
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('obsidian://open?vault=notes')
  })
})
