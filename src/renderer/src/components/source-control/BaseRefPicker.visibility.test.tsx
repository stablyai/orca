// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { create } from 'zustand'
import { AppStateViewContext } from '@/store/retained-views/app-state-view'
import { BaseRefPicker } from './BaseRefPicker'

const refs = vi.hoisted(() => ({ values: [] as string[], defaultRef: null as string | null }))
vi.mock('@/runtime/source-control/references/runtime-repo-client', () => ({
  watchRuntimeRepoBaseRefDefault: (_host, _repo, handlers) => {
    handlers.onResult({ defaultBaseRef: refs.defaultRef, remoteCount: 1 })
    return () => {}
  },
  searchRuntimeRepoBaseRefs: async () => refs.values
}))

const snapshot = useAppStore.getState()
const frozen = create(() => snapshot)

afterEach(() => {
  cleanup()
  refs.values = []
  refs.defaultRef = null
})

it('retains the branch search input when a section pauses and resumes observation', () => {
  const picker = (
    <BaseRefPicker repoId="repo" hostId="local" currentBaseRef="main" onSelect={() => {}} />
  )
  const view = render(
    <AppStateViewContext.Provider value={useAppStore}>{picker}</AppStateViewContext.Provider>
  )
  const search = view.getByRole('textbox')
  fireEvent.change(search, { target: { value: 'feature/unfinished' } })

  view.rerender(
    <AppStateViewContext.Provider value={frozen}>{picker}</AppStateViewContext.Provider>
  )
  view.rerender(
    <AppStateViewContext.Provider value={useAppStore}>{picker}</AppStateViewContext.Provider>
  )
  expect(view.getByRole('textbox')).toHaveProperty('value', 'feature/unfinished')
})

it('distinguishes colliding actions and marks the remote identified by the default probe', async () => {
  refs.defaultRef = 'origin/main'
  refs.values = ['refs/heads/origin/main', 'refs/remotes/origin/main']
  const select = vi.fn()
  const view = render(<BaseRefPicker repoId="repo" hostId="local" onSelect={select} />)
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'origin/main' } })
  const local = await view.findByRole('button', { name: 'refs/heads/origin/main' })
  const remote = view.getByRole('button', { name: 'refs/remotes/origin/main Current' })
  expect(local.textContent).toBe('refs/heads/origin/main')
  expect(local.getAttribute('aria-current')).toBeNull()
  expect(remote.getAttribute('aria-current')).toBe('true')
  fireEvent.click(remote)
  await waitFor(() => expect(select).toHaveBeenCalledWith('refs/remotes/origin/main'))
})

it.each(['main', 'origin/main'])('keeps an older server default marked for %s', async (ref) => {
  refs.defaultRef = ref
  refs.values = [ref]
  const select = vi.fn()
  const view = render(<BaseRefPicker repoId="repo" hostId="local" onSelect={select} />)
  fireEvent.change(view.getByRole('textbox'), { target: { value: ref } })
  const current = await view.findByRole('button', { name: `${ref} Current` })
  expect(current.getAttribute('aria-current')).toBe('true')
  fireEvent.click(current)
  expect(select).toHaveBeenCalledWith(ref)
})
