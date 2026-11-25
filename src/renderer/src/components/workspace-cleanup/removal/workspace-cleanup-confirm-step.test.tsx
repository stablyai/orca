// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { Dialog } from '@/components/ui/dialog'
import { makeFacetCandidate as makeCandidate } from '../query/workspace-cleanup-facet.test.fixture'
import {
  splitWorkspaceCleanupConfirmSections,
  WorkspaceCleanupConfirmStep
} from './workspace-cleanup-confirm-step'

afterEach(cleanup)

function row(name: string, dirty: boolean): WorkspaceCleanupCandidate {
  const base = makeCandidate({ worktreeId: `repo-1::/repo/${name}`, displayName: name })
  return dirty ? { ...base, blockers: ['dirty-files'], git: { ...base.git, clean: false } } : base
}

const rows = (count: number, dirty: boolean, prefix: string) =>
  Array.from({ length: count }, (_, index) => row(`${prefix}${index}`, dirty))

describe('splitWorkspaceCleanupConfirmSections', () => {
  it('lists rows needing approval first and the rest as nothing local', () => {
    const sections = splitWorkspaceCleanupConfirmSections([row('a', false), row('b', true)])
    expect(sections.localFiles.map((candidate) => candidate.displayName)).toEqual(['b'])
    expect(sections.nothingLocal.map((candidate) => candidate.displayName)).toEqual(['a'])
  })
})

describe('WorkspaceCleanupConfirmStep', () => {
  const mount = (candidates: WorkspaceCleanupCandidate[]) =>
    render(
      <Dialog>
        <WorkspaceCleanupConfirmStep
          candidates={candidates}
          now={1_700_000_000_000}
          onBack={vi.fn()}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />
      </Dialog>
    )

  it('shows five rows of a long section and reveals the rest on request', () => {
    mount([...rows(9, true, 'risk'), ...rows(3, false, 'safe')])
    const [local, nothing] = screen.getAllByRole('region')
    expect(within(local).getAllByRole('listitem')).toHaveLength(5)
    expect(within(nothing).getAllByRole('listitem')).toHaveLength(3)

    fireEvent.click(within(local).getByRole('button'))
    expect(within(local).getAllByRole('listitem')).toHaveLength(9)
    expect(within(local).queryByRole('button')).toBeNull()
  })

  it('does not collapse a section of eight or fewer rows', () => {
    mount(rows(8, true, 'risk'))
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
  })
})
