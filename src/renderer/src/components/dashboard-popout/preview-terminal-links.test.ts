import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installPreviewTerminalLinks } from './preview-terminal-links'
import type { PreviewFileLinkActivation } from './preview-terminal-file-links'

const openUrl = vi.fn(() => Promise.resolve(true))

vi.mock('@xterm/addon-web-links', () => ({
  // The addon's regex scan is xterm's business; these tests cover the OSC 8
  // route, which reaches xterm through options.linkHandler instead.
  WebLinksAddon: class {
    dispose(): void {}
  }
}))
vi.mock('@/lib/pane-manager/terminal-link-provider-guard', () => ({
  installGuardedLinkProviderRegistration: vi.fn()
}))

function installOn(): {
  terminal: Terminal
  fileLinks: PreviewFileLinkActivation[]
  hints: string[]
} {
  const terminal = {
    options: {} as Terminal['options'],
    loadAddon: vi.fn(),
    clearSelection: vi.fn()
  } as unknown as Terminal
  const fileLinks: PreviewFileLinkActivation[] = []
  const hints: string[] = []
  installPreviewTerminalLinks(terminal, {
    hover: (text) => hints.push(text),
    openFileLink: (activation) => fileLinks.push(activation)
  })
  return { terminal, fileLinks, hints }
}

function modifierClick(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    ctrlKey: true,
    metaKey: true,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides
  } as unknown as MouseEvent
}

describe('preview terminal OSC 8 links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
  })

  it('claims OSC 8 links so xterm cannot fall back to its blocked window.open', () => {
    // Regression: with no linkHandler xterm confirms "this link could
    // potentially be dangerous" and then opens nothing at all.
    expect(installOn().terminal.options.linkHandler).toBeTruthy()
  })

  it('opens an OSC 8 URL in the system browser on Mod+click', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.activate(
      modifierClick(),
      'https://www.figma.com/design/abc',
      {} as never
    )

    expect(openUrl).toHaveBeenCalledWith('https://www.figma.com/design/abc')
  })

  it('ignores a plain click so selection still works', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.activate(
      modifierClick({ ctrlKey: false, metaKey: false }),
      'https://example.com',
      {} as never
    )

    expect(openUrl).not.toHaveBeenCalled()
  })

  it('routes a file:// OSC 8 target through the workspace file opener', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.activate(
      modifierClick(),
      'file:///Users/dev/work/src/app%20one.ts',
      {} as never
    )

    expect(openUrl).not.toHaveBeenCalled()
    expect(preview.fileLinks).toEqual([
      {
        path: '/Users/dev/work/src/app one.ts',
        line: null,
        column: null,
        openWithSystemDefault: false
      }
    ])
  })

  it('preserves the host of a UNC file:// target', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.activate(
      modifierClick(),
      'file://server/share/file.ts',
      {} as never
    )

    expect(preview.fileLinks).toEqual([
      {
        path: '//server/share/file.ts',
        line: null,
        column: null,
        openWithSystemDefault: false
      }
    ])
  })

  it('leaves an unknown protocol alone rather than handing it to the OS', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.activate(
      modifierClick(),
      'javascript:alert(1)',
      {} as never
    )

    expect(openUrl).not.toHaveBeenCalled()
    expect(preview.fileLinks).toEqual([])
  })

  it('names the gesture when hovering an OSC 8 link', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.hover?.(
      modifierClick(),
      'https://example.com',
      {} as never
    )

    expect(preview.hints[0]).toContain('https://example.com')
    expect(preview.hints[0]).toContain('click to open')
  })

  it('describes opening the file, not the browser, when hovering a file:// OSC 8 link', () => {
    const preview = installOn()
    preview.terminal.options.linkHandler?.hover?.(
      modifierClick(),
      'file:///Users/dev/work/src/app.ts',
      {} as never
    )

    expect(preview.hints[0]).toContain('file:///Users/dev/work/src/app.ts')
    expect(preview.hints[0]).not.toContain('browser')
  })
})
