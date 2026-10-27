// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { buildSidebarHostOptions } from './sidebar-host-options'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  getDeleteWorktreeDirtyChangePreview,
  type DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function buildHostLabels(
  hostLabelOverrides?: ReadonlyMap<ExecutionHostId, string>
): ReadonlyMap<ExecutionHostId, string> {
  return new Map(
    buildSidebarHostOptions({
      repos: [
        { connectionId: 'qa-linux-42' },
        { connectionId: null, executionHostId: 'runtime:runtime-7' }
      ],
      sshTargetLabels: new Map([['qa-linux-42', 'QA Linux']]),
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [{ id: 'runtime-7', name: 'Build Mac' }],
      hostLabelOverrides
    }).map((host) => [host.id, host.label])
  )
}

const savedHostLabels = buildHostLabels()

function makeWorktree(id: string, displayName: string, hostId?: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/work/${displayName}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    ...(hostId ? { hostId } : {})
  } as Worktree
}

function renderPreview(args: {
  worktrees: readonly Worktree[]
  collisionWorktrees?: readonly Worktree[]
  worktree?: Worktree | null
  isBatchDelete?: boolean
  hostLabelById?: ReadonlyMap<ExecutionHostId, string>
  dirtyChangeCountsByWorktreeId?: ReadonlyMap<string, number>
  dirtyChangePreviewsByWorktreeId?: ReadonlyMap<string, DeleteWorktreeDirtyChangePreview>
}): void {
  render(
    <DeleteWorktreeTargetPreview
      isBatchDelete={args.isBatchDelete ?? true}
      worktree={args.worktree ?? null}
      worktrees={args.worktrees}
      collisionWorktrees={args.collisionWorktrees ?? args.worktrees}
      hostLabelById={args.hostLabelById ?? savedHostLabels}
      deleteStateByWorktreeId={{}}
      dirtyChangeCountsByWorktreeId={args.dirtyChangeCountsByWorktreeId ?? new Map()}
      dirtyChangePreviewsByWorktreeId={args.dirtyChangePreviewsByWorktreeId ?? new Map()}
    />
  )
}

afterEach(cleanup)

describe('DeleteWorktreeTargetPreview host labels', () => {
  it('binds saved SSH and runtime host names to their colliding batch rows', () => {
    renderPreview({
      worktrees: [
        makeWorktree('shared', 'collide', 'ssh:qa-linux-42'),
        makeWorktree('shared', 'collide', 'runtime:runtime-7')
      ]
    })

    const sshRow = screen.getByRole('listitem', { name: /QA Linux/ })
    const runtimeRow = screen.getByRole('listitem', { name: /Build Mac/ })
    expect(sshRow).toHaveAccessibleName('collide /work/collide QA Linux')
    expect(within(sshRow).getByText('QA Linux')).toBeVisible()
    expect(within(sshRow).queryByText('Build Mac')).not.toBeInTheDocument()
    expect(runtimeRow).toHaveAccessibleName('collide /work/collide Build Mac')
    expect(within(runtimeRow).getByText('Build Mac')).toBeVisible()
    expect(within(runtimeRow).queryByText('QA Linux')).not.toBeInTheDocument()
  })

  it('uses configured display-label overrides for colliding hosts', () => {
    const worktrees = [
      makeWorktree('shared', 'collide', 'ssh:qa-linux-42'),
      makeWorktree('shared', 'collide', 'runtime:runtime-7')
    ]
    renderPreview({
      worktrees,
      hostLabelById: buildHostLabels(
        new Map([
          ['ssh:qa-linux-42', 'SSH override'],
          ['runtime:runtime-7', 'Runtime override']
        ])
      )
    })

    expect(screen.getByRole('listitem', { name: /SSH override/ })).toHaveTextContent('SSH override')
    expect(screen.getByRole('listitem', { name: /Runtime override/ })).toHaveTextContent(
      'Runtime override'
    )
  })

  it('keeps an unqualified colliding target distinct from local', () => {
    renderPreview({
      worktrees: [makeWorktree('shared', 'collide'), makeWorktree('shared', 'collide', 'local')]
    })

    const unknownRow = screen.getByRole('listitem', { name: /Unknown host/ })
    expect(within(unknownRow).getByText('Unknown host')).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('omits host metadata from every ordinary batch row', () => {
    renderPreview({
      worktrees: [
        makeWorktree('one', 'alpha', 'local'),
        makeWorktree('two', 'beta', 'ssh:qa-linux-42')
      ]
    })

    const alphaRow = screen.getByRole('listitem', { name: 'alpha /work/alpha' })
    const betaRow = screen.getByRole('listitem', { name: 'beta /work/beta' })
    expect(within(alphaRow).queryByText(savedHostLabels.get('local')!)).not.toBeInTheDocument()
    expect(within(betaRow).queryByText('QA Linux')).not.toBeInTheDocument()
  })

  it('includes the host in a colliding single target region and its accessible name', () => {
    const sshWorktree = makeWorktree('shared', 'collide', 'ssh:qa-linux-42')
    const runtimeWorktree = makeWorktree('shared', 'unselected', 'runtime:runtime-7')
    renderPreview({
      isBatchDelete: false,
      worktree: sshWorktree,
      worktrees: [sshWorktree],
      collisionWorktrees: [sshWorktree, runtimeWorktree]
    })

    const target = screen.getByRole('region', { name: /QA Linux/ })
    expect(target).toHaveAccessibleName('collide /work/collide QA Linux')
    expect(within(target).getByText('QA Linux')).toBeVisible()
    expect(screen.queryByText('unselected')).not.toBeInTheDocument()
  })

  it('omits the host from an ordinary single target region', () => {
    const sshWorktree = makeWorktree('one', 'alpha', 'ssh:qa-linux-42')
    renderPreview({ isBatchDelete: false, worktree: sshWorktree, worktrees: [sshWorktree] })

    const target = screen.getByRole('region', { name: 'alpha /work/alpha' })
    expect(target).toHaveAccessibleName('alpha /work/alpha')
    expect(within(target).queryByText('QA Linux')).not.toBeInTheDocument()
  })
})

describe('DeleteWorktreeTargetPreview loaded paths', () => {
  it('expands a single warning into ten loaded paths while retaining the entry count', () => {
    const worktree = makeWorktree('one', 'alpha')
    const entries: GitStatusEntry[] = [
      { path: 'src/app.ts', status: 'added', area: 'staged' },
      { path: 'src/app.ts', status: 'modified', area: 'unstaged' },
      { path: 'scratch.txt', status: 'untracked', area: 'untracked' },
      ...Array.from({ length: 10 }, (_, index) => ({
        path: `build/out-${index}.js`,
        status: 'added' as const,
        area: 'staged' as const
      }))
    ]
    renderPreview({
      isBatchDelete: false,
      worktree,
      worktrees: [worktree],
      dirtyChangeCountsByWorktreeId: new Map([['one', entries.length]]),
      dirtyChangePreviewsByWorktreeId: new Map([
        ['one', getDeleteWorktreeDirtyChangePreview(entries)]
      ])
    })

    const trigger = screen.getByRole('button', {
      name: '13 uncommitted or untracked changes: Show loaded paths'
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('src/app.ts')).not.toBeInTheDocument()
    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('src/app.ts')).toHaveLength(1)
    expect(screen.getByText('scratch.txt')).toBeVisible()
    expect(screen.getByText('build/out-7.js')).toBeVisible()
    expect(screen.queryByText('build/out-8.js')).not.toBeInTheDocument()
    expect(screen.getByText('and 2 more loaded paths')).toBeVisible()
    expect(screen.getByText('Loaded paths may be incomplete or out of date.')).toBeVisible()
    expect(screen.getByLabelText('modified')).toHaveTextContent('M')
    expect(screen.getByLabelText('untracked')).toHaveTextContent('U')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('src/app.ts')).not.toBeInTheDocument()
  })

  it('keeps a generic warning without an empty list when only deletion proved it dirty', () => {
    const worktree = makeWorktree('one', 'alpha')
    renderPreview({
      isBatchDelete: false,
      worktree,
      worktrees: [worktree],
      dirtyChangeCountsByWorktreeId: new Map([['one', 0]])
    })
    expect(screen.getByText('Uncommitted or untracked changes')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/No files|clean|0 changes/)).not.toBeInTheDocument()
  })

  it('opens the selected host preview and closes the previous preview', () => {
    const local = makeWorktree('same', 'collide', 'local')
    const runtime = makeWorktree('same', 'collide', 'runtime:runtime-7')
    const localKey = getWorktreeHostIdentity(local)
    const runtimeKey = getWorktreeHostIdentity(runtime)
    renderPreview({
      worktrees: [local, runtime],
      dirtyChangeCountsByWorktreeId: new Map([
        [localKey, 1],
        [runtimeKey, 1]
      ]),
      dirtyChangePreviewsByWorktreeId: new Map([
        [
          localKey,
          getDeleteWorktreeDirtyChangePreview([
            { path: 'local.ts', status: 'deleted', area: 'unstaged' }
          ])
        ],
        [
          runtimeKey,
          getDeleteWorktreeDirtyChangePreview([
            { path: 'runtime.ts', status: 'renamed', area: 'staged' }
          ])
        ]
      ])
    })
    const localRow = screen.getByRole('listitem', { name: /Local/ })
    const runtimeRow = screen.getByRole('listitem', { name: /Build Mac/ })
    fireEvent.click(within(localRow).getByRole('button'))
    expect(screen.getByText('local.ts')).toBeVisible()
    expect(within(runtimeRow).queryByText('runtime.ts')).not.toBeInTheDocument()
    expect(screen.getByLabelText('deleted')).toHaveTextContent('D')
    fireEvent.click(within(runtimeRow).getByRole('button'))
    expect(screen.getByText('runtime.ts')).toBeVisible()
    expect(screen.queryByText('local.ts')).not.toBeInTheDocument()
    expect(screen.getByLabelText('renamed')).toHaveTextContent('R')
  })
})
