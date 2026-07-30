// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { GitStashEntry } from '../../../../shared/git-stash-types'

const { listRuntimeGitStashesMock, pushRuntimeGitStashMock } = vi.hoisted(() => ({
  listRuntimeGitStashesMock: vi.fn(),
  pushRuntimeGitStashMock: vi.fn()
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  listRuntimeGitStashes: listRuntimeGitStashesMock,
  pushRuntimeGitStash: pushRuntimeGitStashMock,
  applyRuntimeGitStash: vi.fn(),
  popRuntimeGitStash: vi.fn(),
  dropRuntimeGitStash: vi.fn(),
  clearRuntimeGitStashes: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))

import { useSourceControlStash, type SourceControlStash } from './useSourceControlStash'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// Why: SourceControl passes a memoized `activeRepoSettings`, so a stable
// reference here is what the real call site actually provides.
const SETTINGS = {} as GlobalSettings
const NOOP_CONFIRM = async (): Promise<boolean> => true
const NOOP_AFTER_MUTATION = async (): Promise<void> => {}

function entry(index: number): GitStashEntry {
  return {
    ref: `stash@{${index}}`,
    index,
    commitOid: `${index}`.repeat(40).slice(0, 40),
    createdAtSeconds: 1785416506,
    subject: `stash ${index}`
  }
}

const roots: Root[] = []
let latest: SourceControlStash | null = null

function HookProbe(props: { worktreeId: string }): null {
  latest = useSourceControlStash(
    {
      settings: SETTINGS,
      worktreeId: props.worktreeId,
      worktreePath: `/repo/${props.worktreeId}`,
      isGitWorkspace: true
    },
    NOOP_CONFIRM,
    NOOP_AFTER_MUTATION
  )
  return null
}

function render(worktreeId: string): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(createElement(HookProbe, { worktreeId }))
  })
  return { root, container }
}

beforeEach(() => {
  listRuntimeGitStashesMock.mockReset()
  pushRuntimeGitStashMock.mockReset()
  pushRuntimeGitStashMock.mockResolvedValue({ success: true, stashed: true })
  latest = null
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
})

describe('useSourceControlStash', () => {
  it('starts with an unknown count so the menu can say "Checking stashes…"', () => {
    listRuntimeGitStashesMock.mockResolvedValue([])
    render('wt-a')
    expect(latest?.stashCount).toBeUndefined()
  })

  it('reads the count on refresh', async () => {
    listRuntimeGitStashesMock.mockResolvedValue([entry(0), entry(1)])
    render('wt-a')

    await act(async () => {
      await latest?.refreshStashCount()
    })

    expect(latest?.stashCount).toBe(2)
  })

  it('clears the count when the worktree changes', async () => {
    listRuntimeGitStashesMock.mockResolvedValue([entry(0)])
    const { root } = render('wt-a')
    await act(async () => {
      await latest?.refreshStashCount()
    })
    expect(latest?.stashCount).toBe(1)

    act(() => {
      root.render(createElement(HookProbe, { worktreeId: 'wt-b' }))
    })

    expect(latest?.stashCount).toBeUndefined()
  })

  it('discards a refresh that resolves after the worktree switched', async () => {
    // Why: the stale count would re-enable pop/apply/drop for a worktree that
    // has no stashes, so the user gets an enabled row that errors on click.
    let resolveA: (value: GitStashEntry[]) => void = () => {}
    listRuntimeGitStashesMock.mockReturnValueOnce(
      new Promise<GitStashEntry[]>((resolve) => {
        resolveA = resolve
      })
    )
    const { root } = render('wt-a')

    let pending: Promise<void> | undefined
    act(() => {
      pending = latest?.refreshStashCount()
    })

    act(() => {
      root.render(createElement(HookProbe, { worktreeId: 'wt-b' }))
    })

    await act(async () => {
      resolveA([entry(0), entry(1), entry(2)])
      await pending
    })

    expect(latest?.stashCount).toBeUndefined()
  })

  it('keeps a stable facade identity across re-renders so callers can memoize', () => {
    listRuntimeGitStashesMock.mockResolvedValue([])
    const { root } = render('wt-a')
    const first = latest

    act(() => {
      root.render(createElement(HookProbe, { worktreeId: 'wt-a' }))
    })

    expect(latest).toBe(first)
    expect(latest?.refreshStashCount).toBe(first?.refreshStashCount)
    expect(latest?.runStashAction).toBe(first?.runStashAction)
  })

  it('opens the picker for the three picker actions instead of running git', async () => {
    listRuntimeGitStashesMock.mockResolvedValue([])
    render('wt-a')

    await act(async () => {
      await latest?.runStashAction('stash_pop_pick')
    })
    expect(latest?.pickerMode).toBe('stash_pop_pick')

    act(() => {
      latest?.closePicker()
    })
    expect(latest?.pickerMode).toBeNull()
  })

  describe('naming a stash', () => {
    it.each(['stash', 'stash_include_untracked'] as const)(
      'opens the prompt for %s instead of stashing straight away',
      async (kind) => {
        listRuntimeGitStashesMock.mockResolvedValue([])
        render('wt-a')

        await act(async () => {
          await latest?.runStashAction(kind)
        })

        expect(latest?.messagePromptMode).toBe(kind)
        expect(pushRuntimeGitStashMock).not.toHaveBeenCalled()
      }
    )

    it('passes the typed name through to git', async () => {
      listRuntimeGitStashesMock.mockResolvedValue([])
      render('wt-a')
      await act(async () => {
        await latest?.runStashAction('stash')
      })

      await act(async () => {
        await latest?.submitStashMessage('  half-finished refactor  ')
      })

      expect(pushRuntimeGitStashMock).toHaveBeenCalledWith(expect.anything(), {
        includeUntracked: false,
        message: 'half-finished refactor'
      })
      expect(latest?.messagePromptMode).toBeNull()
    })

    it('omits the message when confirmed empty so git writes its own subject', async () => {
      // Why: an empty name is a valid choice, not an omission — sending "" would
      // be rejected by the length guard instead of falling back to "WIP on ...".
      listRuntimeGitStashesMock.mockResolvedValue([])
      render('wt-a')
      await act(async () => {
        await latest?.runStashAction('stash_include_untracked')
      })

      await act(async () => {
        await latest?.submitStashMessage('   ')
      })

      expect(pushRuntimeGitStashMock).toHaveBeenCalledWith(expect.anything(), {
        includeUntracked: true
      })
    })

    it('cancelling aborts the stash entirely', async () => {
      // Why: cancel and confirm-empty must not collapse into the same outcome.
      listRuntimeGitStashesMock.mockResolvedValue([])
      render('wt-a')
      await act(async () => {
        await latest?.runStashAction('stash')
      })

      act(() => {
        latest?.cancelStashMessage()
      })

      expect(latest?.messagePromptMode).toBeNull()
      expect(pushRuntimeGitStashMock).not.toHaveBeenCalled()
    })
  })

  it('no-ops for a folder workspace', async () => {
    listRuntimeGitStashesMock.mockResolvedValue([entry(0)])
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(
        createElement(function FolderProbe() {
          latest = useSourceControlStash(
            {
              settings: SETTINGS,
              worktreeId: 'wt-folder',
              worktreePath: '/folder',
              isGitWorkspace: false
            },
            NOOP_CONFIRM,
            NOOP_AFTER_MUTATION
          )
          return null
        })
      )
    })

    await act(async () => {
      await latest?.refreshStashCount()
    })

    expect(listRuntimeGitStashesMock).not.toHaveBeenCalled()
    expect(latest?.stashCount).toBeUndefined()
  })
})
