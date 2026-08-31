// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { buildSidebarHostOptions } from './sidebar-host-options'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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
}): void {
  render(
    <DeleteWorktreeTargetPreview
      isBatchDelete={args.isBatchDelete ?? true}
      worktree={args.worktree ?? null}
      worktrees={args.worktrees}
      collisionWorktrees={args.collisionWorktrees ?? args.worktrees}
      hostLabelById={args.hostLabelById ?? savedHostLabels}
      deleteStateByWorktreeId={{}}
      dirtyChangeCountsByWorktreeId={new Map()}
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
