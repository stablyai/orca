import type { IDisposable, ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { createFilePathLinkProvider } from './terminal-link-handlers'
import { getTerminalFileOpenHint } from '../terminal-link-open-hints'

import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  collectLinks,
  createProvider,
  createProviderSetup,
  makeBufferLine,
  makeExistsCache,
  makePane
} from './terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, fsPathExistsMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('createFilePathLinkProvider range bounds', () => {
  it('underlines only the filename itself, not the column padding from `ls`', async () => {
    // xterm end.x is inclusive and 1-based; endIndex + 1 incorrectly underlines ls padding after the filename.
    const line = 'CLAUDE.md      package.json     README.md'
    const links = await collectLinks(line)
    const byText = new Map(links.map((link) => [link.text, link]))

    const claude = byText.get('CLAUDE.md')
    expect(claude, 'CLAUDE.md should be linkified').toBeDefined()
    expect(claude!.range.start.x).toBe(1)
    expect(claude!.range.end.x).toBe('CLAUDE.md'.length)

    const pkg = byText.get('package.json')
    expect(pkg, 'package.json should be linkified').toBeDefined()
    const pkgStartIndex = line.indexOf('package.json')
    expect(pkg!.range.start.x).toBe(pkgStartIndex + 1)
    expect(pkg!.range.end.x).toBe(pkgStartIndex + 'package.json'.length)
  })

  it('does not invoke the xterm callback twice when the callback throws', async () => {
    const { provider } = createProviderSetup([makeBufferLine('CLAUDE.md')])
    const callback = vi.fn(() => {
      throw new Error('terminal was disposed')
    })

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
  })

  it('does not reuse SSH path-exists cache entries across connections', async () => {
    setPlatform('Macintosh')
    const pathExistsCache = makeExistsCache()
    const rows = [makeBufferLine('shared.ts')]
    const pane = makePane(rows)
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const deps = {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      startupCwd: '/repo',
      managerRef,
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache
    }

    vi.mocked(getConnectionId).mockReturnValue('ssh-one')
    const firstProvider = createFilePathLinkProvider(
      1,
      deps,
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )
    const firstLinks = await new Promise<ILink[]>((resolve) => {
      firstProvider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(firstLinks.map((link) => link.text)).toEqual(['shared.ts'])
    expect(fsPathExistsMock).toHaveBeenCalledWith({
      filePath: '/repo/shared.ts',
      connectionId: 'ssh-one'
    })

    vi.mocked(getConnectionId).mockReturnValue('ssh-two')
    fsPathExistsMock.mockResolvedValueOnce(false)
    const secondProvider = createFilePathLinkProvider(
      1,
      deps,
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )
    const secondLinks = await new Promise<ILink[]>((resolve) => {
      secondProvider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(secondLinks).toEqual([])
    expect(fsPathExistsMock).toHaveBeenLastCalledWith({
      filePath: '/repo/shared.ts',
      connectionId: 'ssh-two'
    })
  })

  it('returns one file link for an absolute path containing spaces', async () => {
    const pathText = '/repo/Folder With Space/content.js'
    const links = await collectLinks(pathText)

    expect(links.map((link) => link.text)).toEqual([pathText])
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: pathText.length, y: 1 }
    })
  })

  it('returns one file link for an extensionless path ending in a spaced segment', async () => {
    const pathText = '/repo/My Folder'
    const links = await collectLinks(pathText)

    expect(links.map((link) => link.text)).toEqual([pathText])
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: pathText.length, y: 1 }
    })
  })

  it('returns an existing extensionless spaced prefix before trailing prose', async () => {
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (pathValue) => {
      return pathValue === '/repo/My Folder'
    })

    const links = await collectLinks('see /repo/My Folder now')

    expect(links.map((link) => link.text)).toEqual(['/repo/My Folder'])
  })

  it('returns a wrapped file link when hovering the first physical row', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]

    const links = await collectLinks(rows, 1)
    const link = links.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )

    expect(link, 'wrapped path should be linkified from the first row').toBeDefined()
    expect(link!.range).toEqual({
      start: { x: 'open '.length + 1, y: 1 },
      end: { x: 'terminal-link-handlers.ts'.length, y: 2 }
    })
  })

  it('maps file link columns through multi-code-unit characters before the path', async () => {
    const text = 'e\u0301 src/main.ts'
    const columns = [0, 0, 1]
    for (let index = 3; index < text.length; index++) {
      columns[index] = index - 1
    }
    columns[text.length] = text.length - 1

    const links = await collectLinks([makeBufferLine(text, { columns })])
    const link = links.find((candidate) => candidate.text === 'src/main.ts')

    expect(link, 'unicode-prefixed path should be linkified').toBeDefined()
    expect(link!.range.start.x).toBe(3)
    expect(link!.range.end.x).toBe(text.length - 1)
  })

  it('drops stale async file links when wrapped rows change before existence resolves', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]
    const provider = createProvider(rows)
    const exists = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(() => exists.promise)
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    rows[0] = makeBufferLine('changed src/other/')

    exists.resolve(true)
    await flushAsyncWork()
    await flushAsyncWork()

    expect(callback).not.toHaveBeenCalled()
  })
})
