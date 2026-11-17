// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getTaskProjectPickerGroups } from '../task-page-default-repo-selection'
import TaskProjectSourceCombobox from './task-project-source-combobox'

afterEach(cleanup)

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    badgeColor: '#3b82f6',
    addedAt: 1,
    kind: 'git',
    upstream: { owner: 'me', repo: 'bun_root' },
    ...overrides
  }
}

describe('TaskProjectSourceCombobox', () => {
  it('lets a single-host fork be picked as the task source of its upstream project', () => {
    const upstreamRepo = makeRepo({
      id: 'bun-root',
      path: '/work/bun_root',
      displayName: 'bun_root'
    })
    const forkRepo = makeRepo({
      id: 'earepo',
      path: '/work/earepo',
      displayName: 'earepo',
      addedAt: 2
    })
    const onChange = vi.fn()
    render(
      <TaskProjectSourceCombobox
        groups={getTaskProjectPickerGroups([upstreamRepo, forkRepo])}
        selected={new Set([upstreamRepo.id])}
        onChange={onChange}
        onSelectAll={vi.fn()}
        getRepoHostLabel={() => 'This computer'}
      />
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.mouseEnter(screen.getByTitle('Choose task source'))
    fireEvent.click(screen.getByRole('button', { name: /^earepo\s*\/work\/earepo$/ }))

    expect(onChange).toHaveBeenCalledWith(new Set([forkRepo.id]))
  })
})
