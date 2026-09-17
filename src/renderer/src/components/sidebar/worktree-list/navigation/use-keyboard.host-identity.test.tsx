// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import type { RenderRow } from '../listing/render-row'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

const activateAndRevealWorkspace = vi.fn()

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: (...args: unknown[]) => activateAndRevealWorkspace(...args)
}))

vi.mock('@/store', () => {
  const state = {
    keybindings: undefined,
    worktreeNavHistory: [] as string[],
    worktreeNavHistoryIndex: -1
  }
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')
const { useAppStore } = await import('@/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { id: 'repo-1', path: '/repo-1', displayName: 'Repo 1' }

// Local worktrees carry no `hostId` — `withRepoHostOwnership` leaves them unqualified.
function localRow(id: string): HostSectionRow & { type: 'item' } {
  return {
    type: 'item',
    rowKey: `row:${id}`,
    sectionKey: 'repo:repo-1',
    worktree: { id, repoId: repo.id } as unknown as Worktree,
    repo: repo as never,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const rows: HostSectionRow[] = [localRow('a'), localRow('b'), localRow('c')]

let container: HTMLDivElement
let root: Root

function press(direction: 'up' | 'down'): void {
  const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        code: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...mod
      })
    )
  })
}

type ProbeProps = {
  activeWorktreeId: string | null
  activeHostId: 'local' | 'ssh:host-b' | null
  probeRows: HostSectionRow[]
}

// Why a stable component: re-rendering with new props keeps the hook instance (and its
// refs) alive the way the real sidebar does; a fresh component per render would remount.
function Probe({ activeWorktreeId, activeHostId, probeRows }: ProbeProps): null {
  useWorktreeListKeyboardNavigation({
    rows: probeRows,
    renderRows: probeRows as unknown as RenderRow[],
    activeWorktreeId,
    activeWorkspaceExecutionHostId: activeHostId,
    pinnedDisplayPolicy: 'single-location',
    virtualizer: { scrollToIndex: () => {} } as never,
    scrollRef: { current: null },
    activeModal: 'none',
    markDirectScrollInput: () => {}
  })
  return null
}

function renderProbe(
  activeWorktreeId: string | null,
  activeHostId: 'local' | 'ssh:host-b' | null,
  probeRows: HostSectionRow[] = rows
): void {
  act(() =>
    root.render(
      <Probe
        activeWorktreeId={activeWorktreeId}
        activeHostId={activeHostId}
        probeRows={probeRows}
      />
    )
  )
}

beforeEach(() => {
  activateAndRevealWorkspace.mockClear()
  const navState = useAppStore.getState() as {
    worktreeNavHistory: string[]
    worktreeNavHistoryIndex: number
  }
  navState.worktreeNavHistory = []
  navState.worktreeNavHistoryIndex = -1
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('worktree keyboard cycling with a resolved active host', () => {
  it('steps to the next row when the active host resolved to local but rows are unqualified', () => {
    // Why: a sidebar click activates with the repo-resolved host (`local`), while
    // local rows carry no hostId; a raw identity compare misses and wraps to the top.
    renderProbe('b', 'local')

    press('down')

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('c', {})
  })

  it('steps to the previous row when the active host resolved to local', () => {
    renderProbe('b', 'local')

    press('up')

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('a', {})
  })

  it('still steps normally when the active host is unqualified', () => {
    renderProbe('b', null)

    press('down')

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('c', {})
  })

  it('anchors on the twin of the host that was active after a close cleared the selection', () => {
    const sshRow = (id: string): HostSectionRow => ({
      ...localRow(id),
      rowKey: `row:${id}:ssh`,
      sectionKey: 'host:ssh:host-b',
      worktree: { id, repoId: repo.id, hostId: 'ssh:host-b' } as unknown as Worktree
    })
    const twinRows: HostSectionRow[] = [
      localRow('shared'),
      localRow('a'),
      sshRow('shared'),
      sshRow('b')
    ]
    // The user was on the SSH twin; closing its last tab clears the selection and its host.
    renderProbe('shared', 'ssh:host-b', twinRows)
    const navState = useAppStore.getState() as {
      worktreeNavHistory: string[]
      worktreeNavHistoryIndex: number
    }
    navState.worktreeNavHistory = ['shared']
    navState.worktreeNavHistoryIndex = 0
    renderProbe(null, null, twinRows)

    press('down')

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('b', { executionHostId: 'ssh:host-b' })
  })
})
