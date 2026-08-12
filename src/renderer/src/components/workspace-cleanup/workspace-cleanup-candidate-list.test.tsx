// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS,
  WorkspaceCleanupCandidateList
} from './workspace-cleanup-candidate-list'
import { CandidateRow } from './workspace-cleanup-candidate-row'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

let root: Root | null = null
let container: HTMLDivElement | null = null

function makeRows(count: number): WorkspaceCleanupCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    makeCandidate({ worktreeId: `wt-${index}`, displayName: `Workspace ${index}` })
  )
}

describe('WorkspaceCleanupCandidateList', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('renders every row in natural flow below the virtualization threshold', () => {
    const rows = makeRows(WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS - 1)
    const rendered: string[] = []

    act(() => {
      root?.render(
        <WorkspaceCleanupCandidateList
          rows={rows}
          scrollElement={null}
          renderRow={(candidate) => {
            rendered.push(candidate.worktreeId)
            return <div key={candidate.worktreeId} data-testid="row" />
          }}
        />
      )
    })

    expect(rendered).toHaveLength(rows.length)
    expect(container?.querySelectorAll('[data-testid="row"]')).toHaveLength(rows.length)
    // Plain path keeps natural flow: no absolute-positioned windowing wrappers.
    expect(container?.querySelector('[data-index]')).toBeNull()
  })

  it('windows rows into an absolutely positioned container at the threshold', () => {
    const rows = makeRows(WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS)
    // A real element enables the virtualizer; happy-dom reports zero-size layout,
    // so this asserts the windowed structure rather than a specific mounted count.
    const scrollElement = document.createElement('div')

    act(() => {
      root?.render(
        <WorkspaceCleanupCandidateList
          rows={rows}
          scrollElement={scrollElement}
          renderRow={(candidate) => <div key={candidate.worktreeId} data-testid="row" />}
        />
      )
    })

    const windowed = container?.querySelector('.absolute') != null
    const mounted = container?.querySelectorAll('[data-testid="row"]').length ?? 0
    // Windowed mode never mounts more than the full set, and switches away from
    // the plain flow used below the threshold.
    expect(mounted).toBeLessThanOrEqual(rows.length)
    expect(windowed || mounted === 0).toBe(true)
  })

  it('memoizes CandidateRow so unchanged rows skip re-render', () => {
    expect((CandidateRow as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })
})
