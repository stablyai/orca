// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { LineBlameStatusSegment } from './LineBlameStatusSegment'
import { useAppStore } from '@/store'
import { resetLineBlameRequestsForTests } from '@/lib/line-blame-request'
import type { GitLineBlameResult } from '../../../../shared/git-line-blame-types'

const blameMocks = vi.hoisted(() => ({
  getRuntimeGitLineBlame: vi.fn(),
  // Null keeps these cases on the per-line path they are written to exercise;
  // whole-file blame has its own tests in line-blame-request.test.ts.
  getRuntimeGitFileBlame: vi.fn(async () => null)
}))
const i18nMocks = vi.hoisted(() => ({ locale: 'en-US' }))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitLineBlame: blameMocks.getRuntimeGitLineBlame,
  getRuntimeGitFileBlame: blameMocks.getRuntimeGitFileBlame
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined,
  getConnectionIdForFile: () => undefined
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  getIntlLocale: () => i18nMocks.locale
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

const WORKTREE_PATH = '/repo'

function blame(author: string): GitLineBlameResult {
  return {
    sha: 'a'.repeat(40),
    author,
    authorTimeMs: Date.parse('2026-01-01T00:00:00Z'),
    summary: 'change something',
    isUncommitted: false
  }
}

function openFile(
  overrides: { isDirty?: boolean; runtimeEnvironmentId?: string | null } = {}
): void {
  useAppStore.setState({
    activeFileId: 'file-1',
    openFiles: [
      {
        id: 'file-1',
        filePath: `${WORKTREE_PATH}/src/index.ts`,
        relativePath: 'src/index.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: overrides.isDirty ?? false,
        runtimeEnvironmentId: overrides.runtimeEnvironmentId ?? null
      }
    ],
    editorCursorLine: { 'file-1': 5 },
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', path: WORKTREE_PATH }] },
    folderWorkspaces: []
  } as unknown as Parameters<typeof useAppStore.setState>[0])
}

function setCursorLine(line: number): void {
  act(() => {
    useAppStore.setState({ editorCursorLine: { 'file-1': line } } as unknown as Parameters<
      typeof useAppStore.setState
    >[0])
  })
}

async function flushDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300)
    await Promise.resolve()
  })
}

describe('LineBlameStatusSegment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    blameMocks.getRuntimeGitLineBlame.mockReset()
    resetLineBlameRequestsForTests()
    i18nMocks.locale = 'en-US'
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('debounces cursor movement into a single blame for the resting line', async () => {
    blameMocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)

    setCursorLine(6)
    setCursorLine(7)
    setCursorLine(8)
    await flushDebounce()

    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)
    expect(blameMocks.getRuntimeGitLineBlame.mock.calls[0][1]).toEqual({
      filePath: 'src/index.ts',
      line: 8
    })
  })

  it('keeps one blame in flight and then runs only the latest queued line', async () => {
    const resolvers: ((value: GitLineBlameResult | null) => void)[] = []
    blameMocks.getRuntimeGitLineBlame.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve))
    )
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)

    await flushDebounce()
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    // Two more resting positions while the first request is still pending.
    setCursorLine(10)
    await flushDebounce()
    setCursorLine(11)
    await flushDebounce()
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvers[0]?.(blame('Neil'))
      await Promise.resolve()
    })

    // Exactly one follow-up request, for the newest line — not one per move.
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)
    expect(blameMocks.getRuntimeGitLineBlame.mock.calls[1][1]).toEqual({
      filePath: 'src/index.ts',
      line: 11
    })
  })

  it("never shows one line's author beside another line", async () => {
    // Why: the annotation is anchored to the cursor line, so keeping the
    // previous line's authorship visible while the next request runs would
    // attribute line 5's commit to line 40.
    blameMocks.getRuntimeGitLineBlame.mockResolvedValueOnce(blame('Line Five Author'))
    blameMocks.getRuntimeGitLineBlame.mockImplementation(() => new Promise(() => {}))
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)
    await flushDebounce()
    expect(screen.queryAllByText(/Line Five Author/).length).toBeGreaterThan(0)

    setCursorLine(40)

    expect(screen.queryAllByText(/Line Five Author/)).toHaveLength(0)
  })

  it('repaints a revisited line from cache without asking git again', async () => {
    blameMocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)
    await flushDebounce()
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    setCursorLine(40)
    await flushDebounce()
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)

    // Back to the first line: no third request, and authorship is on screen
    // immediately rather than after another debounce.
    await act(async () => {
      setCursorLine(5)
    })
    expect(blameMocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)
    expect(screen.queryAllByText(/Neil/).length).toBeGreaterThan(0)
  })

  it('drops a response that resolves after the runtime owner changed', async () => {
    // Why: both requests stay pending, so a stale paint would survive instead of
    // being overwritten by the follow-up response.
    let resolveFirst: ((value: GitLineBlameResult | null) => void) | undefined
    blameMocks.getRuntimeGitLineBlame.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    blameMocks.getRuntimeGitLineBlame.mockImplementation(() => new Promise(() => {}))
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)
    await flushDebounce()

    // Same worktree, file, and line — only the runtime owner moved.
    act(() => {
      openFile({ runtimeEnvironmentId: 'env-2' })
    })
    await flushDebounce()

    await act(async () => {
      resolveFirst?.(blame('Stale Host'))
      await Promise.resolve()
    })

    expect(screen.queryByText(/Stale Host/)).toBeNull()
  })

  it('formats the relative date in the app UI language, not the system locale', async () => {
    i18nMocks.locale = 'ja-JP'
    const old = blame('Neil')
    old.authorTimeMs = Date.now() - 3 * 24 * 60 * 60 * 1000
    blameMocks.getRuntimeGitLineBlame.mockResolvedValue(old)
    openFile()
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)
    await flushDebounce()

    // Why: a module-scope formatter built with `undefined` would follow the
    // system locale and render "3 days ago" whatever the app language is.
    expect(screen.getByLabelText(/Neil · 3 日前/)).toBeInTheDocument()
  })

  it('shows no authorship while the buffer is dirty', async () => {
    blameMocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))
    openFile({ isDirty: true })
    render(<LineBlameStatusSegment compact={false} iconOnly={false} />)
    await flushDebounce()

    expect(blameMocks.getRuntimeGitLineBlame).not.toHaveBeenCalled()
    expect(screen.queryByText(/Neil/)).toBeNull()
  })
})
