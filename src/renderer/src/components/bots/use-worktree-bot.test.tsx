// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorkspaceLineage } from '@/store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getFolderWorkspaceWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { useWorktreeBot } from './use-worktree-bot'

const ranger = { id: 'bot-1', name: 'Ranger', folderWorkspaceId: 'bot-home', hostId: 'local' }

vi.mock('@/lib/bot-catalog', () => ({ useBots: (enabled: boolean) => (enabled ? [ranger] : []) }))

const original = useAppStore.getState()

const wt = makeWorktree({ id: 'wt', repoId: 'repo-1', instanceId: 'current' })

function seed(childInstanceId: string): void {
  useAppStore.setState({
    hideBotCreatedWorkspaces: false,
    folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home' })],
    worktreesByRepo: { 'repo-1': [wt] },
    workspaceLineageByChildKey: {
      [worktreeWorkspaceKey('wt')]: makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey('wt'),
        childInstanceId,
        parentWorkspaceKey: 'folder:bot-home',
        origin: 'orchestration'
      })
    }
  })
}

describe('useWorktreeBot', () => {
  afterEach(() => useAppStore.setState(original, true))

  it('names the bot whose worker made this worktree', () => {
    seed('current')
    const { result } = renderHook(() => useWorktreeBot(wt, true))
    expect(result.current?.name).toBe('Ranger')
  })

  it('ignores a link recorded for an earlier worktree at the same path', () => {
    seed('earlier')
    const { result } = renderHook(() => useWorktreeBot(wt, true))
    expect(result.current).toBeNull()
  })

  it('names the bot a folder workspace was handed to, keyed by the folder row id', () => {
    const notes = makeFolderWorkspace({ id: 'notes' })
    useAppStore.setState({
      hideBotCreatedWorkspaces: false,
      folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home' }), notes],
      workspaceLineageByChildKey: {
        'folder:notes': makeWorkspaceLineage({
          childWorkspaceKey: 'folder:notes',
          childInstanceId: null,
          parentWorkspaceKey: 'folder:bot-home',
          origin: 'orchestration'
        })
      }
    })
    const { result } = renderHook(() => useWorktreeBot(getFolderWorkspaceWorktree(notes), true))
    expect(result.current?.name).toBe('Ranger')
  })

  it('names the bot for any workspace under its home on another machine, however it got there', () => {
    const remote = (id: string) =>
      makeWorktree({
        id,
        repoId: 'win-repo',
        path: `C:/${id}`,
        hostId: 'runtime:windows-2',
        runtimeOwnerEnvironmentId: 'windows-2',
        instanceId: `instance-${id}`
      })
    const worker = remote('win-repo::C:/worker')
    const byHand = remote('win-repo::C:/by-hand')
    const record = (row: typeof worker, origin: 'orchestration' | 'cli') => ({
      childWorkspaceKey: worktreeWorkspaceKey(row.id),
      childInstanceId: row.instanceId,
      parent: {
        installationId: 'this-mac',
        workspaceKey: 'folder:bot-home',
        instanceId: 'bot-home'
      },
      origin,
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: 1
    })
    useAppStore.setState((state) => ({
      hideBotCreatedWorkspaces: false,
      folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home' })],
      worktreesByRepo: { 'win-repo': [worker, byHand] },
      ownLineageInstallationId: 'this-mac',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only hostDescriptor.installationId from these partial status fixtures.
      runtimeStatusByEnvironmentId: new Map([
        ['windows-2', { status: { hostDescriptor: { installationId: 'windows-2-install' } } }]
      ]) as unknown as typeof state.runtimeStatusByEnvironmentId,
      crossStoreLineageByStoreKey: {
        'windows-2': {
          [worktreeWorkspaceKey(worker.id)]: record(worker, 'orchestration'),
          [worktreeWorkspaceKey(byHand.id)]: record(byHand, 'cli')
        }
      }
    }))
    expect(renderHook(() => useWorktreeBot(worker, true)).result.current?.name).toBe('Ranger')
    expect(renderHook(() => useWorktreeBot(byHand, true)).result.current?.name).toBe('Ranger')
  })
})
