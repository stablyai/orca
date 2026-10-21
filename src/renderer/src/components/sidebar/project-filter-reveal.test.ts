import { describe, expect, it, vi } from 'vitest'
import { revealRepoInProjectFilter } from './project-filter-reveal'

function makeState(filterRepoIds: readonly string[]) {
  return { filterRepoIds, setFilterRepoIds: vi.fn() }
}

describe('revealRepoInProjectFilter', () => {
  it('keeps the existing selection and adds the revealed project', () => {
    const state = makeState(['repo-a', 'repo-b'])

    revealRepoInProjectFilter(state, 'repo-c')

    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['repo-a', 'repo-b', 'repo-c'])
  })

  it('does nothing when no project filter is active', () => {
    const state = makeState([])

    revealRepoInProjectFilter(state, 'repo-c')

    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
  })

  it('does nothing when the project is already selected', () => {
    const state = makeState(['repo-a', 'repo-c'])

    revealRepoInProjectFilter(state, 'repo-c')

    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
  })
})
