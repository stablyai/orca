// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as VirtualBindings from '@tanstack/react-virtual'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GitHubPRFile,
  GitHubPRFileContents
} from '../../../../../shared/github/pull-request-types'
import { prFilesDiffScrollTopCache, prFilesDiffViewStateCache } from '../cache/files-diff-view'
import { PRFilesCombinedDiffViewer } from './combined-diff-viewer'

const prFileContents = vi.hoisted(() => vi.fn())
const liveVirtualizer = vi.hoisted(
  (): { current: { resizeItem: (index: number, size: number) => void } | null } => ({
    current: null
  })
)

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof VirtualBindings>()
  return {
    ...actual,
    useVirtualizer: (
      options: Parameters<typeof actual.useVirtualizer<HTMLDivElement, Element>>[0]
    ) => {
      const virtualizer = actual.useVirtualizer({
        ...options,
        getScrollElement: () => {
          const node = options.getScrollElement()
          if (node && node.offsetHeight === 0) {
            Object.defineProperties(node, {
              clientHeight: { value: 400, configurable: true },
              offsetHeight: { value: 400, configurable: true },
              offsetWidth: { value: 900, configurable: true },
              scrollHeight: { value: 2400, configurable: true }
            })
          }
          return node
        }
      })
      if (options.getScrollElement()?.hasAttribute('data-combined-diff-viewport')) {
        liveVirtualizer.current = virtualizer
      }
      return virtualizer
    }
  }
})

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="pr-diff-editor" data-original={original} data-modified={modified} />
  )
}))

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: {
      getModel: () => null,
      getModels: () => []
    },
    Uri: {
      parse: (value: string) => value
    }
  }
}))

const multiLineText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')

function makeFiles(states: Record<string, GitHubPRFile['viewerViewedState']> = {}): GitHubPRFile[] {
  return [
    {
      path: 'src/alpha.ts',
      status: 'modified',
      additions: 20,
      deletions: 2,
      isBinary: false,
      viewerViewedState: states['src/alpha.ts'] ?? 'UNVIEWED'
    },
    {
      path: 'src/beta.ts',
      status: 'modified',
      additions: 10,
      deletions: 1,
      isBinary: false,
      viewerViewedState: states['src/beta.ts'] ?? 'UNVIEWED'
    }
  ]
}

function getRowByIndex(index: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-combined-diff-section-row][data-index="${index}"]`
  )
  if (!row) {
    throw new Error(`Missing row ${index}`)
  }
  return row
}

function getViewport(): HTMLDivElement {
  const viewport = document.querySelector<HTMLDivElement>('[data-combined-diff-viewport]')
  if (!viewport) {
    throw new Error('Missing viewport')
  }
  return viewport
}

beforeEach(() => {
  prFileContents.mockReset()
  prFileContents.mockImplementation(
    async ({ filePath }: { filePath: string }): Promise<GitHubPRFileContents> => ({
      original: `${filePath}:before\n${multiLineText}`,
      modified: `${filePath}:after\n${multiLineText}`,
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  )
  vi.stubGlobal('api', {
    gh: { prFileContents },
    ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  prFilesDiffScrollTopCache.clear()
  prFilesDiffViewStateCache.clear()
  document.body.replaceChildren()
})

function Viewer({
  files,
  headSha = 'head-1',
  onViewedChange = vi.fn().mockResolvedValue(true)
}: {
  files: GitHubPRFile[]
  headSha?: string
  onViewedChange?: (path: string, viewed: boolean) => Promise<boolean>
}): React.JSX.Element {
  return (
    <TooltipProvider>
      <PRFilesCombinedDiffViewer
        files={files}
        comments={[]}
        repoPath="/repo"
        repoId="repo-1"
        prNumber={12}
        prUrl="https://github.com/acme/repo/pull/12"
        headSha={headSha}
        baseSha="base-1"
        pendingViewedPaths={new Set()}
        onCommentAdded={vi.fn()}
        onViewedChange={onViewedChange}
      />
    </TooltipProvider>
  )
}

const alphaIsExpanded = (): boolean =>
  getRowByIndex(0).querySelector('[data-testid="pr-diff-editor"]') !== null

describe('PRFilesCombinedDiffViewer viewed collapse', () => {
  it('opens viewed files collapsed without loading them, and again after new commits', async () => {
    const files = makeFiles({ 'src/alpha.ts': 'VIEWED' })
    const { rerender } = render(<Viewer files={files} />)

    await waitFor(() =>
      expect(getRowByIndex(1).querySelector('[data-testid="pr-diff-editor"]')).toBeTruthy()
    )
    expect(alphaIsExpanded()).toBe(false)
    expect(prFileContents.mock.calls.map(([arg]) => arg.path)).toEqual(['src/beta.ts'])

    fireEvent.click(getRowByIndex(0).querySelector('[data-combined-diff-section-header]')!)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))

    rerender(<Viewer files={files} headSha="head-2" />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(false))
  })

  it('collapses on Viewed with the header back in view, and expands on clearing it', async () => {
    const { rerender } = render(<Viewer files={makeFiles()} />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
    const viewport = getViewport()
    viewport.scrollTop = 300
    fireEvent.scroll(viewport)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    })
    expect(alphaIsExpanded()).toBe(false)
    expect(viewport.scrollTop).toBe(0)

    rerender(<Viewer files={makeFiles({ 'src/alpha.ts': 'VIEWED' })} />)
    expect(alphaIsExpanded()).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    })
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
  })

  it('keeps the header in view when the collapsed row then measures differently', async () => {
    render(<Viewer files={makeFiles()} />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
    const viewport = getViewport()
    viewport.scrollTop = 300
    fireEvent.scroll(viewport)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    })
    act(() => liveVirtualizer.current?.resizeItem(0, 99))
    expect(viewport.scrollTop).toBe(0)
  })

  it('keeps the header in view when a saved scroll position is still restoring', async () => {
    const { unmount } = render(<Viewer files={makeFiles()} />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
    getViewport().scrollTop = 5000
    unmount()
    // Holds the restore at its first clamped attempt, however long the render takes.
    vi.stubGlobal('requestAnimationFrame', () => 0)

    render(<Viewer files={makeFiles()} />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
    const viewport = getViewport()
    viewport.scrollTop = 300

    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    })
    expect(alphaIsExpanded()).toBe(false)
    expect(viewport.scrollTop).toBe(0)
  })

  it('undoes the collapse when saving Viewed fails', async () => {
    const save = Promise.withResolvers<boolean>()
    render(<Viewer files={makeFiles()} onViewedChange={() => save.promise} />)
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))

    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    await waitFor(() => expect(alphaIsExpanded()).toBe(false))

    await act(async () => {
      save.resolve(false)
    })
    await waitFor(() => expect(alphaIsExpanded()).toBe(true))
  })
})
