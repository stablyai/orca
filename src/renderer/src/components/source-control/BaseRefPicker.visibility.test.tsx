// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { create } from 'zustand'
import { AppStateViewContext } from '@/store/retained-views/app-state-view'
import { BaseRefPicker } from './BaseRefPicker'

vi.mock('@/runtime/source-control/references/runtime-repo-client', () => ({
  watchRuntimeRepoBaseRefDefault: () => () => {},
  searchRuntimeRepoBaseRefs: async () => []
}))

const snapshot = useAppStore.getState()
const frozen = create(() => snapshot)

afterEach(cleanup)

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
