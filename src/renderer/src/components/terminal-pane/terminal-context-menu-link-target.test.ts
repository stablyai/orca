import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalContextMenuLinkCopyText,
  type TerminalContextMenuLinkTarget
} from './terminal-context-menu-link-target'

const linkMocks = vi.hoisted(() => ({
  getPosition: vi.fn(),
  findHttp: vi.fn()
}))

vi.mock('./terminal-mouse-buffer-position', () => ({
  getTerminalBufferPositionForMouseEvent: linkMocks.getPosition
}))
vi.mock('./terminal-url-link-hit-testing', () => ({
  findHttpLinkAtBufferPosition: linkMocks.findHttp
}))

describe('getTerminalContextMenuLinkCopyText', () => {
  it('copies the full URL for http targets', () => {
    const target: TerminalContextMenuLinkTarget = {
      kind: 'http',
      url: 'https://example.com/path?q=1',
      sourceOwner: { kind: 'local' }
    }
    expect(getTerminalContextMenuLinkCopyText(target)).toBe('https://example.com/path?q=1')
  })

  it('copies the absolute path for file targets', () => {
    const target: TerminalContextMenuLinkTarget = {
      kind: 'file',
      absolutePath: '/tmp/repo/src/main.ts',
      line: 12,
      column: 3,
      pathText: 'src/main.ts:12:3'
    }
    expect(getTerminalContextMenuLinkCopyText(target)).toBe('/tmp/repo/src/main.ts')
  })
})

describe('resolveTerminalContextMenuLinkTarget', () => {
  it('retains the clicked pane host for HTTP link actions', async () => {
    linkMocks.getPosition.mockReturnValue({ x: 1, y: 1 })
    linkMocks.findHttp.mockReturnValue('https://example.com')
    const { resolveTerminalContextMenuLinkTarget } =
      await import('./terminal-context-menu-link-target')
    const sourceOwner = { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const

    expect(
      resolveTerminalContextMenuLinkTarget(
        { cols: 80, buffer: { active: {} } } as never,
        {} as never,
        {
          startupCwd: '/repo',
          worktreeId: 'repo::/repo',
          worktreePath: '/repo',
          sourceOwner
        }
      )
    ).toEqual({ kind: 'http', url: 'https://example.com', sourceOwner })
  })
})
