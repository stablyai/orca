// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CreateFromPicker } from './CreateFromPicker'
import { TooltipProvider } from '../ui/tooltip'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'

const refs = vi.hoisted(() => ({
  defaultRef: 'origin/main',
  values: ['refs/heads/origin/main', 'refs/remotes/origin/main']
}))
vi.mock('@/runtime/source-control/references/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault: async () => ({ defaultBaseRef: refs.defaultRef, remoteCount: 1 }),
  searchRuntimeRepoBaseRefs: async () => refs.values
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refs.defaultRef = 'origin/main'
  refs.values = ['refs/heads/origin/main', 'refs/remotes/origin/main']
})

it('keeps deferred search focus through typing and cancels it when the picker closes', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const flushFrames = () => {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach((callback) => callback(0)))
  }
  const repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
  const view = render(
    <TooltipProvider>
      <CreateFromPicker
        repoId="repo"
        repoMap={new Map([['repo', repo]])}
        worktrees={[]}
        value=""
        onValueChange={() => {}}
      />
    </TooltipProvider>
  )
  const trigger = view.getByRole('combobox')
  fireEvent.click(trigger)
  const input = await view.findByPlaceholderText('Search repo branches...')
  fireEvent.change(input, { target: { value: 'origin' } })
  flushFrames()
  expect(document.activeElement).toBe(input)

  fireEvent.click(trigger)
  fireEvent.click(trigger)
  const reopened = await view.findByPlaceholderText('Search repo branches...')
  const focus = vi.spyOn(reopened, 'focus')
  fireEvent.click(trigger)
  flushFrames()
  expect(focus).not.toHaveBeenCalled()
})

it('uses the latest project default and default action after a rerender', async () => {
  refs.values = ['refs/heads/main', 'refs/heads/topic']
  refs.defaultRef = 'main'
  const initial = vi.fn()
  const latest = vi.fn()
  const repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
  const picker = (defaultRef: string, onSetDefault: (branch: string) => void) => (
    <TooltipProvider>
      <CreateFromPicker
        repoId="repo"
        repoMap={new Map([['repo', { ...repo, worktreeBaseRef: defaultRef }]])}
        worktrees={[]}
        value=""
        onValueChange={() => {}}
        onSetDefault={onSetDefault}
      />
    </TooltipProvider>
  )
  const view = render(picker('refs/heads/main', initial))
  fireEvent.click(view.getByRole('combobox'))
  await view.findByRole('option', { name: 'topic' })
  view.rerender(picker('refs/heads/topic', latest))
  fireEvent.contextMenu(view.getByRole('option', { name: 'topic (default)' }))
  expect(
    (await view.findByRole('menuitem', { name: 'Current default' })).getAttribute('aria-disabled')
  ).toBe('true')
  fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(view.queryByRole('menu')).toBeNull())
  fireEvent.contextMenu(view.getByRole('option', { name: 'main' }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Set as default' }))
  expect(initial).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledWith('refs/heads/main')
})

it('keeps the colliding local branch selectable beside a remote project default', async () => {
  const selected = vi.fn()
  const repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
  const view = render(
    <TooltipProvider>
      <CreateFromPicker
        repoId="repo"
        repoMap={new Map([['repo', repo]])}
        worktrees={[]}
        value=""
        onValueChange={selected}
      />
    </TooltipProvider>
  )
  fireEvent.click(view.getByRole('combobox'))
  const local = await view.findByRole('option', { name: 'refs/heads/origin/main' })
  expect(view.getByRole('option', { name: 'origin/main (default)' })).toBeTruthy()
  fireEvent.click(local)
  expect(selected).toHaveBeenCalledWith('refs/heads/origin/main')
})

it.each(['main', 'origin/main'])(
  'merges an older server default %s without changing its action',
  async (ref) => {
    refs.defaultRef = ref
    refs.values = [ref, 'topic']
    const selected = vi.fn()
    const repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
    const view = render(
      <TooltipProvider>
        <CreateFromPicker
          repoId="repo"
          repoMap={new Map([['repo', repo]])}
          worktrees={
            ref === 'main' ? [makeWorktree({ id: 'main', repoId: 'repo', branch: 'main' })] : []
          }
          value=""
          onValueChange={selected}
        />
      </TooltipProvider>
    )
    fireEvent.click(view.getByRole('combobox'))
    const topic = await view.findByRole('option', { name: 'topic' })
    expect(view.getAllByRole('option')).toHaveLength(2)
    expect(view.getByRole('option', { name: `${ref} (default)` })).toBeTruthy()
    fireEvent.click(topic)
    expect(selected).toHaveBeenCalledWith('topic')
  }
)
