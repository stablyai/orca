// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import { GitHistoryPanel } from './GitHistoryPanel'
import type { SourceControlRowOpenEvent } from './source-control-split-open'
import {
  SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
  SOURCE_CONTROL_FILE_ROW_OVERSCAN
} from './source-control-virtual-file-list'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const VIEWPORT_HEIGHT_PX = 240
const COMMIT_ROW_HEIGHT_PX = 28
const MAX_MOUNTED_ROWS =
  Math.ceil(VIEWPORT_HEIGHT_PX / SOURCE_CONTROL_FILE_ROW_HEIGHT_PX) +
  2 * SOURCE_CONTROL_FILE_ROW_OVERSCAN +
  8

type OpenCommitFile = (
  item: GitHistoryItem,
  entry: GitBranchChangeEntry,
  event?: SourceControlRowOpenEvent
) => void

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('scrollbar-sleek')) {
        return VIEWPORT_HEIGHT_PX
      }
      return this.dataset.testid === 'git-history-row'
        ? COMMIT_ROW_HEIGHT_PX
        : SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('scrollbar-sleek')
      ? VIEWPORT_HEIGHT_PX
      : this instanceof HTMLElement && this.dataset.testid === 'git-history-row'
        ? COMMIT_ROW_HEIGHT_PX
        : SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    return {
      top: 0,
      bottom: height,
      height,
      left: 0,
      right: 320,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderExpandedHistory({
  entries,
  viewMode,
  onOpenCommitFile = vi.fn()
}: {
  entries: GitBranchChangeEntry[]
  viewMode: 'list' | 'tree'
  onOpenCommitFile?: Mock<OpenCommitFile>
}) {
  const item: GitHistoryItem = {
    id: 'a'.repeat(40),
    displayId: 'a'.repeat(7),
    parentIds: [],
    subject: 'Large root commit',
    message: 'Large root commit',
    author: 'Test Author',
    timestamp: 1_700_000_000
  }
  const result: GitHistoryResult = {
    items: [item],
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
  const onLoadCommitFiles = vi
    .fn<(item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>>()
    .mockResolvedValue(entries)

  act(() => {
    root.render(
      <GitHistoryPanel
        state={{ status: 'ready', result }}
        collapsed={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
        onLoadCommitFiles={onLoadCommitFiles}
        onOpenCommitFile={onOpenCommitFile}
        commitFilesViewMode={viewMode}
        onCommitFilesViewModeChange={vi.fn()}
      />
    )
  })

  const commit = host.querySelector<HTMLButtonElement>('[data-testid="git-history-row"]')
  if (!commit) {
    throw new Error('Missing commit row')
  }
  await act(async () => {
    commit.click()
    await Promise.resolve()
    await Promise.resolve()
  })

  return { item, onLoadCommitFiles, onOpenCommitFile }
}

function scrollHistoryTo(offset: number): void {
  const scroller = host.querySelector<HTMLDivElement>('.scrollbar-sleek')
  if (!scroller) {
    throw new Error('Missing history scroller')
  }
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    writable: true,
    value: offset
  })
  scroller.scrollTop = offset
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

function mountedFiles(): HTMLButtonElement[] {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>('button[data-testid="git-history-commit-file"]')
  )
}

describe('GitHistoryPanel virtualization', () => {
  it('bounds a 500-file list and routes a deep row without reloading the commit', async () => {
    const entries: GitBranchChangeEntry[] = Array.from({ length: 500 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
      added: index,
      removed: 0
    }))
    const onOpenCommitFile = vi.fn<OpenCommitFile>()
    const { item, onLoadCommitFiles } = await renderExpandedHistory({
      entries,
      viewMode: 'list',
      onOpenCommitFile
    })

    expect(mountedFiles().length).toBeGreaterThan(0)
    expect(mountedFiles().length).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
    expect(host.querySelector('[data-file-path="src/file-000.ts"]')).not.toBeNull()

    scrollHistoryTo(COMMIT_ROW_HEIGHT_PX + 490 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)

    const deepEntry = entries[490]
    const deepFile = host.querySelector<HTMLButtonElement>('[data-file-path="src/file-490.ts"]')
    expect(deepFile).not.toBeNull()
    expect(host.querySelector('[data-file-path="src/file-000.ts"]')).toBeNull()
    act(() => {
      deepFile?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    })

    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
    expect(onOpenCommitFile).toHaveBeenCalledTimes(1)
    const [openedItem, openedEntry, event] = onOpenCommitFile.mock.calls[0] ?? []
    expect(openedItem).toMatchObject(item)
    expect(openedEntry).toBe(deepEntry)
    expect(event).toMatchObject({ ctrlKey: true, altKey: false, shiftKey: false })
  })

  it('bounds tree rows and keeps directory state independent of row mounts', async () => {
    const entries: GitBranchChangeEntry[] = Array.from({ length: 500 }, (_, index) => ({
      path: `src/dir-${String(Math.floor(index / 20)).padStart(3, '0')}/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
      added: index,
      removed: 0
    }))
    const { onLoadCommitFiles } = await renderExpandedHistory({ entries, viewMode: 'tree' })

    expect(mountedFiles().length).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
    const rootDirectory = host.querySelector<HTMLButtonElement>(
      'button[data-testid="git-history-commit-directory"]'
    )
    expect(rootDirectory).not.toBeNull()
    act(() => rootDirectory?.click())
    expect(
      host
        .querySelector('button[data-testid="git-history-commit-directory"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false')
    expect(mountedFiles()).toHaveLength(0)

    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[data-testid="git-history-commit-directory"]')
        ?.click()
    )
    expect(
      host
        .querySelector('button[data-testid="git-history-commit-directory"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true')
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    scrollHistoryTo(COMMIT_ROW_HEIGHT_PX + 515 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)
    expect(host.querySelector('[data-file-path="src/dir-024/file-499.ts"]')).not.toBeNull()
    expect(mountedFiles().length).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  })
})
