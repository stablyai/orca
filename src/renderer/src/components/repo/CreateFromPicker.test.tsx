// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
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
  refs.defaultRef = 'origin/main'
  refs.values = ['refs/heads/origin/main', 'refs/remotes/origin/main']
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
