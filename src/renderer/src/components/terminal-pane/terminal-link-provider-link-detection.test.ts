import type { IDisposable, ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { createFilePathLinkProvider, getTerminalFileOpenHint } from './terminal-link-handlers'
import { TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES } from './terminal-path-exists-cache'
import { getConnectionId } from '@/lib/connection-context'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  collectLinks,
  containsBufferPoint,
  createProvider,
  createProviderSetup,
  makeBufferLine,
  makePane
} from './terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, fsPathExistsMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('createFilePathLinkProvider range bounds', () => {
  it('underlines only the filename itself, not the column padding from `ls`', async () => {
    // ls pads each column with trailing spaces. Regression: the provider used
    // to report `end.x = endIndex + 1`, which in xterm's 1-based *inclusive*
    // convention overshoots the last filename cell by one, underlining the
    // trailing space as well ("package.json ").
    const line = 'CLAUDE.md      package.json     README.md'
    const links = await collectLinks(line)
    const byText = new Map(links.map((link) => [link.text, link]))

    const claude = byText.get('CLAUDE.md')
    expect(claude, 'CLAUDE.md should be linkified').toBeDefined()
    // 'CLAUDE.md' occupies cols 1..9 (inclusive, 1-based). end.x must be 9.
    expect(claude!.range.start.x).toBe(1)
    expect(claude!.range.end.x).toBe('CLAUDE.md'.length)

    const pkg = byText.get('package.json')
    expect(pkg, 'package.json should be linkified').toBeDefined()
    // 'package.json' starts at index 15 → col 16; inclusive end at col 15+12 = 27.
    const pkgStartIndex = line.indexOf('package.json')
    expect(pkg!.range.start.x).toBe(pkgStartIndex + 1)
    expect(pkg!.range.end.x).toBe(pkgStartIndex + 'package.json'.length)
  })

  it('shows the Orca plus default-app hint for local file link hover', async () => {
    setPlatform('Macintosh')
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('CLAUDE.md')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo/CLAUDE.md (Click for actions, ⌘+click to open, or ⇧⌘+click for default app)'
    )
  })

  it('recovers with no links when a path-existence probe rejects (SSH teardown)', async () => {
    // Regression: a rejected probe used to escape the void Promise.all as an
    // unhandled rejection the crash-breadcrumb buffer retained, leaking heap (#8260).
    const shellPathExists = vi.mocked(window.api.shell.pathExists)
    shellPathExists.mockRejectedValueOnce(new Error('Remote connection dropped/reconnecting'))
    const { provider } = createProviderSetup([makeBufferLine('CLAUDE.md')], new Map())

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links).toEqual([])
    expect(shellPathExists).toHaveBeenCalled()
  })

  it('does not invoke the xterm callback twice when the callback throws', async () => {
    const { provider } = createProviderSetup([makeBufferLine('CLAUDE.md')])
    const callback = vi.fn(() => {
      throw new Error('terminal was disposed')
    })

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
  })

  it('does not show an unknown trailing-slash directory link', async () => {
    setPlatform('Macintosh')
    const { provider } = createProviderSetup(
      [makeBufferLine('/repo/unknown-dir/')],
      new Map([['active\0/repo/unknown-dir', true]])
    )

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links).toEqual([])
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  })

  it('shows the Orca hint for SSH file link hover', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('CLAUDE.md')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo/CLAUDE.md (Click for actions or ⌘+click to open in Orca)'
    )
  })

  it('bounds the terminal path-exists cache while preserving recent probes', async () => {
    const pathExistsCache = new Map<string, boolean>()
    for (let index = 0; index < TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES; index += 1) {
      pathExistsCache.set(`active\0/repo/old-${index}.ts`, true)
    }
    const pane = makePane([makeBufferLine('fresh.ts')])
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const provider = createFilePathLinkProvider(
      1,
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        startupCwd: '/repo',
        managerRef,
        linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
        pathExistsCache
      },
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links.map((link) => link.text)).toEqual(['fresh.ts'])
    expect(pathExistsCache.size).toBe(TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES)
    expect(pathExistsCache.has('active\0/repo/old-0.ts')).toBe(false)
    expect(pathExistsCache.get('active\0/repo/fresh.ts')).toBe(true)
  })

  it('does not reuse SSH path-exists cache entries across connections', async () => {
    setPlatform('Macintosh')
    const pathExistsCache = new Map<string, boolean>()
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

  it('uses the pane-specific cwd instead of a stale lifecycle startup cwd', async () => {
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (pathValue) => {
      return pathValue === '/repo/package.json'
    })
    const { provider } = createProviderSetup([makeBufferLine('package.json')], new Map(), {
      startupCwd: '/repo/packages/web',
      getPaneLinkCwd: () => '/repo'
    })

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links.map((link) => link.text)).toEqual(['package.json'])
    expect(window.api.shell.pathExists).toHaveBeenCalledWith('/repo/package.json')
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

  it('returns the same wrapped file link when hovering the continuation row', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]

    const firstRowLinks = await collectLinks(rows, 1)
    const continuationLinks = await collectLinks(rows, 2)
    const firstRowLink = firstRowLinks.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )
    const continuationLink = continuationLinks.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )

    expect(
      continuationLink,
      'wrapped path should be linkified from the continuation row'
    ).toBeDefined()
    expect(continuationLink!.text).toBe(firstRowLink!.text)
    expect(continuationLink!.range).toEqual(firstRowLink!.range)
  })

  it('returns all three sibling links and the same boundary link from either row over SSH', async () => {
    const firstPath = 'validation-screenshots/01-before-white-terminal-scrollbar-gutter.png'
    const middleStart = 'validation-screenshots/02-after-'
    const middleEnd = 'transparent-terminal-scrollbar-gutter.png'
    const middlePath = middleStart + middleEnd
    const thirdPath = 'validation-screenshots/03-after-light-theme.png'
    const rows = [
      makeBufferLine(`${firstPath} · ${middleStart}`),
      makeBufferLine(`${middleEnd} · ${thirdPath}`)
    ]
    const completePaths = new Set([firstPath, middlePath, thirdPath].map((path) => `/repo/${path}`))
    vi.mocked(getConnectionId).mockReturnValue('ssh-wrapped')
    fsPathExistsMock.mockImplementation(async ({ filePath }) => completePaths.has(filePath))
    const { provider } = createProviderSetup(rows, new Map())
    const provide = (line: number): Promise<ILink[]> =>
      new Promise((resolve) => provider.provideLinks(line, (links) => resolve(links ?? [])))

    const firstRowLinks = await provide(1)
    const secondRowLinks = await provide(2)
    const firstMiddle = firstRowLinks.find((link) => link.text === middlePath)
    const secondMiddle = secondRowLinks.find((link) => link.text === middlePath)

    expect(firstRowLinks.map((link) => link.text)).toEqual([firstPath, middlePath])
    expect(secondRowLinks.map((link) => link.text)).toEqual([middlePath, thirdPath])
    expect(new Set([...firstRowLinks, ...secondRowLinks].map((link) => link.text))).toEqual(
      new Set([firstPath, middlePath, thirdPath])
    )
    expect(firstMiddle?.range).toEqual({
      start: { x: firstPath.length + ' · '.length + 1, y: 1 },
      end: { x: middleEnd.length, y: 2 }
    })
    expect(secondMiddle?.range).toEqual(firstMiddle?.range)
    expect([...firstRowLinks, ...secondRowLinks].every((link) => !link.text.includes(' · '))).toBe(
      true
    )
    expect(fsPathExistsMock).toHaveBeenCalledWith({
      filePath: `/repo/${middlePath}`,
      connectionId: 'ssh-wrapped'
    })
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
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

  it('reports multi-row ranges that hit-test at wrapped-link boundaries', async () => {
    const rows = [
      makeBufferLine('trace src/very/long/'),
      makeBufferLine('nested/file.ts done', { isWrapped: true })
    ]

    const links = await collectLinks(rows, 2)
    const link = links.find((candidate) => candidate.text === 'src/very/long/nested/file.ts')

    expect(link, 'multi-row path should be linkified').toBeDefined()
    expect(containsBufferPoint(link!, 'trace '.length, 1)).toBe(false)
    expect(containsBufferPoint(link!, 'trace '.length + 1, 1)).toBe(true)
    expect(containsBufferPoint(link!, 'nested/file.ts'.length, 2)).toBe(true)
    expect(containsBufferPoint(link!, 'nested/file.ts'.length + 1, 2)).toBe(false)
  })
})
