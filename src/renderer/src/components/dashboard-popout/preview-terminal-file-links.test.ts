import { describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  makeBufferLine,
  type TestBufferLine
} from '@/components/terminal-pane/terminal-link-provider-buffer-fixtures'
import {
  installPreviewTerminalFileLinks,
  type PreviewFileLinkActivation
} from './preview-terminal-file-links'

function installOn(rows: TestBufferLine[]): {
  links: (bufferLineNumber?: number) => ILink[] | undefined
  activations: PreviewFileLinkActivation[]
  hints: string[]
  clearSelection: ReturnType<typeof vi.fn>
} {
  let provider: ILinkProvider | null = null
  const clearSelection = vi.fn()
  const terminal = {
    buffer: { active: { getLine: (y: number) => rows[y] } },
    registerLinkProvider: (next: ILinkProvider) => {
      provider = next
      return { dispose: vi.fn() }
    },
    clearSelection
  } as unknown as Terminal
  const activations: PreviewFileLinkActivation[] = []
  const hints: string[] = []
  installPreviewTerminalFileLinks(terminal, {
    activate: (activation) => activations.push(activation),
    hover: (text) => hints.push(text)
  })
  return {
    links: (bufferLineNumber = 1) => {
      let resolved: ILink[] | undefined
      provider?.provideLinks(bufferLineNumber, (links) => {
        resolved = links
      })
      return resolved
    },
    activations,
    hints,
    clearSelection
  }
}

function modifierClick(overrides: Partial<MouseEvent> = {}): MouseEvent {
  // Both modifiers so the assertion holds on every client platform.
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

describe('preview terminal file links', () => {
  it('follows a separator path with its line and column', () => {
    const preview = installOn([makeBufferLine('  at src/renderer/app.ts:42:7 failed')])

    const links = preview.links()
    expect(links).toHaveLength(1)
    if (!links || links.length === 0) throw new Error('expected a link')
    links[0].activate(modifierClick(), links[0].text)

    expect(preview.activations).toEqual([
      { path: 'src/renderer/app.ts', line: 42, column: 7, openWithSystemDefault: false }
    ])
    expect(preview.clearSelection).toHaveBeenCalled()
  })

  it('hands the file to the OS default app on Shift+Mod-click, as a pane does', () => {
    const preview = installOn([makeBufferLine('open ./notes/report.pdf')])

    const links = preview.links()
    if (!links || links.length === 0) throw new Error('expected a link')
    links[0].activate(modifierClick({ shiftKey: true }), links[0].text)

    expect(preview.activations[0]?.openWithSystemDefault).toBe(true)
  })

  it('ignores a plain click so selection and TUI mouse input keep working', () => {
    const preview = installOn([makeBufferLine('see src/main/index.ts')])

    const links = preview.links()
    links?.[0].activate(modifierClick({ ctrlKey: false, metaKey: false }), links?.[0].text ?? '')

    expect(preview.activations).toEqual([])
  })

  it('leaves a bare filename unlinked — the preview cannot resolve it', () => {
    // A pane promotes `package.json` only once it resolves against the pane cwd.
    expect(
      installOn([makeBufferLine('edited package.json and tsconfig.json')]).links()
    ).toBeUndefined()
  })

  it('names the gesture on hover so the link is not a dead end', () => {
    const preview = installOn([makeBufferLine('see src/main/index.ts')])

    const links = preview.links()
    if (!links || links.length === 0) throw new Error('expected a link')
    links[0].hover?.(modifierClick(), links[0].text)

    expect(preview.hints[0]).toContain('src/main/index.ts')
    expect(preview.hints[0]).toContain('click to open')
  })

  it('spans a soft-wrapped path across rows', () => {
    const preview = installOn([
      makeBufferLine('src/renderer/src/components/dashboard-popout/'),
      makeBufferLine('AgentTerminalPreview.tsx:12', { isWrapped: true })
    ])

    const links = preview.links(2)
    expect(links?.[0].text).toContain('AgentTerminalPreview.tsx')
    expect(links?.[0].range.start.y).toBe(1)
  })
})
