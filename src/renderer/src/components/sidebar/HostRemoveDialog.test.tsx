// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { HostRemoveDialog } from './HostRemoveDialog'

const initialState = useAppStore.getState()
const onOpenChange = vi.fn()

function dialogs(openHost: string | null) {
  return ['one', 'two'].map((id) => (
    <HostRemoveDialog
      key={id}
      open={openHost === id}
      onOpenChange={onOpenChange}
      hostId={`ssh:${id}`}
      label={id}
      target={{ kind: 'ssh', targetId: id }}
    />
  ))
}

function replaceCatalogs(count: number) {
  useAppStore.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: Array.from({ length: count }, (_, index) =>
        makeWorktree({ id: `workspace-${index}`, repoId: TEST_REPO.id })
      )
    },
    detectedWorktreesByRepo: {}
  })
}

beforeEach(() => {
  useAppStore.setState({
    repos: [{ ...TEST_REPO, connectionId: 'one' }],
    openFiles: [],
    editorDrafts: {}
  })
  replaceCatalogs(1)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('releases both obsolete catalogs and cached indexes while host dialogs stay mounted', async () => {
  const view = render(dialogs(null))

  function openAndCloseHost(id: string) {
    view.rerender(dialogs(id))
    expect(screen.getByRole('dialog')).toHaveTextContent(`Remove ${id}?`)
    const state = useAppStore.getState()
    const retired = {
      worktrees: new WeakRef(state.worktreesByRepo),
      detected: new WeakRef(state.detectedWorktreesByRepo),
      index: new WeakRef(getWorktreeMapFromState(state))
    }
    view.rerender(dialogs(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => replaceCatalogs(2))
    return retired
  }

  const retiredCatalogs = ['one', 'two'].map(openAndCloseHost)
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  for (const retired of retiredCatalogs) {
    expect(retired.worktrees.deref()).toBeUndefined()
    expect(retired.detected.deref()).toBeUndefined()
    expect(retired.index.deref()).toBeUndefined()
  }

  view.rerender(dialogs('one'))
  expect(screen.getByRole('dialog')).toHaveTextContent('Its 3 workspaces stay in Orca')
})

it('keeps workspace details through the closing animation', () => {
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, ...args) => {
    const style = getStyle(element, ...args)
    if (element.getAttribute('data-slot') === 'dialog-content') {
      return new Proxy(style, {
        get: (target, property) =>
          property === 'animationName'
            ? element.getAttribute('data-state') === 'closed'
              ? 'exit'
              : 'enter'
            : // oxlint-disable-next-line anti-slop/no-reflect-get -- Forward CSS properties without changing their receiver.
              Reflect.get(target, property)
      })
    }
    return style
  })
  const view = render(dialogs('one'))
  const dialog = screen.getByRole('dialog')
  const removeButton = screen.getByRole('button', { name: 'Remove host' })
  expect(removeButton).toBeEnabled()
  expect(dialog).toHaveTextContent('Its 2 workspaces stay in Orca')

  view.rerender(dialogs(null))
  expect(dialog).toBeInTheDocument()
  expect(dialog).toHaveAttribute('data-state', 'closed')
  expect(removeButton).toBeDisabled()
  expect(dialog).toHaveTextContent('Its 2 workspaces stay in Orca')

  const event = new Event('animationend', { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: 'exit' })
  fireEvent(dialog, event)
  expect(dialog).not.toBeInTheDocument()
})

it.each(['success', 'failure'] as const)(
  'keeps removal pending across dismiss/reopen and releases it after %s',
  async (outcome) => {
    const pending = Promise.withResolvers<void>()
    const remove = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('api', { ssh: { removeTarget: remove } })
    useAppStore.setState({
      clearRemovedSshTargetState: vi.fn(),
      updateSettings: vi.fn().mockResolvedValue(undefined)
    })
    const view = render(dialogs('one'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }))
    expect(remove).toHaveBeenCalledTimes(1)
    view.rerender(dialogs(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(dialogs('one'))
    const button = screen.getByRole('button', { name: 'Remove host' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(remove).toHaveBeenCalledTimes(1)

    await act(async () => {
      if (outcome === 'success') {
        pending.resolve()
      } else {
        pending.reject(new Error('Removal failed'))
      }
      await pending.promise.catch(() => {})
    })
    expect(button).toBeEnabled()
  }
)
