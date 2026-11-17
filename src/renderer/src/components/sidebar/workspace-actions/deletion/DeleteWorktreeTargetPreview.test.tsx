// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'

afterEach(cleanup)

it('does not present a partial numeric total when one workspace has uncounted dirty changes', () => {
  const worktrees = [
    makeWorktree({ id: 'wt-1', repoId: 'repo-1' }),
    makeWorktree({ id: 'wt-2', repoId: 'repo-1' })
  ]
  const { container } = render(
    <DeleteWorktreeTargetPreview
      isBatchDelete
      worktree={null}
      worktrees={worktrees}
      collisionWorktrees={worktrees}
      hostLabelById={new Map()}
      deleteStateByWorktreeId={{}}
      dirtyChangeCountsByWorktreeId={
        new Map([
          ['wt-1', 3],
          ['wt-2', 0]
        ])
      }
      dirtyChangePreviewsByWorktreeId={new Map()}
    />
  )
  expect(container.querySelector('[data-slot="dialog-warning"]')).toHaveTextContent(
    'Uncommitted changes will be lost'
  )
})

it.each([
  {
    name: 'unsaved-only with incomplete scans',
    changes: undefined,
    unsaved: 2,
    ignored: false,
    incomplete: true,
    warning: '2 unsaved files will be lost'
  },
  {
    name: 'uncommitted changes and ignored files',
    changes: 13,
    unsaved: 0,
    ignored: true,
    incomplete: false,
    warning: '26 uncommitted changes and ignored files will be lost'
  },
  {
    name: 'all three known losses',
    changes: 13,
    unsaved: 2,
    ignored: true,
    incomplete: false,
    warning: '26 uncommitted changes, 2 unsaved files and ignored files will be lost'
  },
  {
    name: 'clean workspaces with incomplete scans',
    changes: undefined,
    unsaved: 0,
    ignored: false,
    incomplete: true,
    warning: null
  },
  {
    name: 'ignored files only',
    changes: undefined,
    unsaved: 0,
    ignored: true,
    incomplete: false,
    warning: 'Ignored files will be lost'
  }
])(
  'preserves the independent consequences for $name',
  ({ changes, unsaved, ignored, incomplete, warning }) => {
    const worktrees = [
      makeWorktree({ id: 'wt-1', repoId: 'repo-1', displayName: 'fix-login' }),
      makeWorktree({ id: 'wt-2', repoId: 'repo-1', displayName: 'docs-refresh' })
    ]
    const { container } = render(
      <DeleteWorktreeTargetPreview
        isBatchDelete
        worktree={null}
        worktrees={worktrees}
        collisionWorktrees={worktrees}
        unsavedFileCount={unsaved}
        hostLabelById={new Map()}
        deleteStateByWorktreeId={{}}
        dirtyChangeCountsByWorktreeId={
          new Map(
            changes === undefined
              ? []
              : [
                  ['wt-1', changes],
                  ['wt-2', changes]
                ]
          )
        }
        dirtyChangePreviewsByWorktreeId={new Map()}
        changeCheckStatesByWorktreeId={
          new Map([
            ['wt-1', incomplete ? 'unavailable' : 'complete'],
            ['wt-2', 'complete']
          ])
        }
        atRiskLocalFilesByIdentity={
          new Map(
            worktrees.map((item) => [
              getWorktreeHostIdentity(item),
              {
                status: 'complete',
                files: {
                  count: ignored ? 2 : 0,
                  samplePaths: ignored ? ['.env'] : [],
                  complete: !incomplete
                }
              }
            ])
          )
        }
      />
    )
    const warnings = container.querySelectorAll('[data-slot="dialog-warning"]')
    expect(warnings).toHaveLength(warning ? 1 : 0)
    if (warning) {
      expect(warnings[0]).toHaveTextContent(warning)
    }
    expect(screen.queryByText('Some changes couldn’t be fully checked.')).toBe(
      incomplete ? screen.getByText('Some changes couldn’t be fully checked.') : null
    )
  }
)
