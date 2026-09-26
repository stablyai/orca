// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'

type FakeWorktree = Pick<Worktree, 'id' | 'repoId' | 'workspaceStatus' | 'hostId'>

type FakeState = {
  keybindings: KeybindingOverrides | undefined
  workspaceStatuses: WorkspaceStatusDefinition[]
  getKnownWorktreeById: (id: string, hostId?: ExecutionHostId) => FakeWorktree | undefined
  updateWorktreeMeta: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const holder: { platform: NodeJS.Platform; state: FakeState | undefined } = {
    platform: 'linux',
    state: undefined
  }
  const currentState = (): FakeState => {
    if (!holder.state) {
      throw new Error('test state not set')
    }
    return holder.state
  }
  return { holder, currentState, toastError: vi.fn() }
})

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => mocks.holder.platform }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/store', () => {
  const useAppStore = (selector: (s: FakeState) => unknown) => selector(mocks.currentState())
  useAppStore.getState = mocks.currentState
  return { useAppStore }
})

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function worktree(id: string, workspaceStatus?: string, hostId?: ExecutionHostId): FakeWorktree {
  return { id, repoId: 'repo-1', workspaceStatus, hostId }
}

function setState(worktrees: FakeWorktree[]): FakeState {
  const state: FakeState = {
    keybindings: undefined,
    workspaceStatuses: DEFAULT_WORKSPACE_STATUSES.map((status) => ({ ...status })),
    getKnownWorktreeById: (id, hostId) =>
      worktrees.find((w) => w.id === id && (!hostId || (w.hostId ?? 'local') === hostId)),
    updateWorktreeMeta: vi.fn(async () => ({ ok: true }))
  }
  mocks.holder.state = state
  return state
}

const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
  count: 0,
  getScrollElement: () => null,
  estimateSize: () => 0,
  scrollToFn: () => {},
  observeElementRect: () => {},
  observeElementOffset: () => {}
})

let container: HTMLDivElement
let root: Root

function renderList(args: {
  activeWorktreeId: string
  activeHostId?: ExecutionHostId | null
  activeModal?: string
}): { list: HTMLDivElement; child: HTMLButtonElement } {
  function Probe(): React.JSX.Element {
    const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
      rows: [],
      renderRows: [],
      activeWorktreeId: args.activeWorktreeId,
      activeWorkspaceExecutionHostId: args.activeHostId ?? null,
      pinnedDisplayPolicy: 'single-location',
      virtualizer,
      scrollRef: { current: null },
      activeModal: args.activeModal ?? 'none',
      markDirectScrollInput: () => {}
    })
    return (
      <div data-testid="list" tabIndex={0} onKeyDown={handleContainerKeyDown}>
        <button type="button">card action</button>
      </div>
    )
  }
  act(() => root.render(<Probe />))
  return {
    list: container.querySelector<HTMLDivElement>('[data-testid="list"]')!,
    child: container.querySelector<HTMLButtonElement>('button')!
  }
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  mocks.holder.platform = 'linux'
  mocks.toastError.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Delete on the focused workspace list', () => {
  it('moves the active In progress workspace to Done without deleting it', () => {
    const state = setState([worktree('a', 'in-progress')])
    const { list } = renderList({ activeWorktreeId: 'a' })

    const event = press(list, 'Delete')

    expect(event.defaultPrevented).toBe(true)
    expect(state.updateWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(state.updateWorktreeMeta).toHaveBeenCalledWith(
      'a',
      { workspaceStatus: 'completed' },
      expect.objectContaining({ executionHostId: 'local' })
    )
  })

  it('treats a workspace with no stored status as In progress', () => {
    const state = setState([worktree('a')])
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Delete')

    expect(state.updateWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('writes to the active host when the same path exists on two hosts', () => {
    const state = setState([worktree('a', 'completed'), worktree('a', 'in-progress', 'ssh:box')])
    const { list } = renderList({ activeWorktreeId: 'a', activeHostId: 'ssh:box' })

    press(list, 'Delete')

    expect(state.updateWorktreeMeta).toHaveBeenCalledWith(
      'a',
      { workspaceStatus: 'completed' },
      expect.objectContaining({ executionHostId: 'ssh:box' })
    )
  })

  it('only lets the save apply to a workspace that is still In progress', () => {
    const state = setState([worktree('a', 'in-progress')])
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Delete')

    const options = state.updateWorktreeMeta.mock.calls[0]?.[2]
    expect(options.shouldApply(worktree('a', 'in-review'))).toBe(false)
    expect(options.shouldApply(worktree('a', 'in-progress'))).toBe(true)
  })

  it('shows the error when saving the status fails', async () => {
    const state = setState([worktree('a', 'in-progress', 'ssh:box')])
    state.updateWorktreeMeta.mockResolvedValueOnce({ ok: false, error: 'SSH host unreachable' })
    const { list } = renderList({ activeWorktreeId: 'a', activeHostId: 'ssh:box' })

    press(list, 'Delete')

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('SSH host unreachable'))
  })

  it('shows no error when the save succeeds', async () => {
    const state = setState([worktree('a', 'in-progress')])
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Delete')

    await expect(state.updateWorktreeMeta.mock.results[0]?.value).resolves.toEqual({ ok: true })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('uses the Mac delete key (Backspace) on macOS only', () => {
    const state = setState([worktree('a', 'in-progress')])
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Backspace')
    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()

    mocks.holder.platform = 'darwin'
    const { list: macList } = renderList({ activeWorktreeId: 'a' })
    press(macList, 'Backspace')
    expect(state.updateWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['In review', 'in-review'],
    ['already Done', 'completed']
  ])('does nothing for a workspace that is %s', (_label, status) => {
    const state = setState([worktree('a', status)])
    const { list } = renderList({ activeWorktreeId: 'a' })

    const event = press(list, 'Delete')

    expect(event.defaultPrevented).toBe(false)
    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does nothing when the custom statuses have no Done column', () => {
    const state = setState([worktree('a', 'in-progress')])
    state.workspaceStatuses = state.workspaceStatuses.filter((status) => status.id !== 'completed')
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Delete')

    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('ignores Delete from a control inside the list, a modal, a held key, or a modifier', () => {
    const state = setState([worktree('a', 'in-progress')])
    const { list, child } = renderList({ activeWorktreeId: 'a' })
    press(child, 'Delete')
    press(list, 'Delete', { repeat: true })
    press(list, 'Delete', { shiftKey: true })

    const { list: modalList } = renderList({ activeWorktreeId: 'a', activeModal: 'edit-meta' })
    press(modalList, 'Delete')

    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('leaves a rebound list key working when there is nothing to mark Done', () => {
    const state = setState([worktree('a', 'in-review')])
    state.keybindings = { 'workspace.markDone': ['Enter'] }
    const { list } = renderList({ activeWorktreeId: 'a' })

    const event = press(list, 'Enter')

    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
    // Enter's own handler (focus the terminal) ran and claimed the key.
    expect(event.defaultPrevented).toBe(true)
  })

  it('respects a user who unbinds the shortcut', () => {
    const state = setState([worktree('a', 'in-progress')])
    state.keybindings = { 'workspace.markDone': [] }
    const { list } = renderList({ activeWorktreeId: 'a' })

    press(list, 'Delete')

    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
  })
})
