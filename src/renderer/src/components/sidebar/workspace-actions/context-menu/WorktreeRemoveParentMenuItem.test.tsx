// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorkspaceLineage } from '@/store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { WorktreeRemoveParentMenuItem } from './WorktreeRemoveParentMenuItem'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
const catalog = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => [{ id: 'bot-1', folderWorkspaceId: 'bot-home', hostId: 'local' }],
  useBotsEnabled: () => catalog.enabled
}))

const original = useAppStore.getState()
const worktree = makeWorktree({ id: 'repo1::/wt', repoId: 'repo1', instanceId: 'current' })

function seed(parentWorkspaceKey: `folder:${string}`): void {
  useAppStore.setState({
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'bot-home' }),
      makeFolderWorkspace({ id: 'plain' })
    ],
    worktreesByRepo: { repo1: [worktree] },
    workspaceLineageByChildKey: {
      [worktreeWorkspaceKey(worktree.id)]: makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: 'current',
        parentWorkspaceKey,
        origin: 'orchestration'
      })
    }
  })
}

describe('WorktreeRemoveParentMenuItem', () => {
  afterEach(() => {
    cleanup()
    catalog.enabled = true
    useAppStore.setState(original, true)
  })

  it("offers Move to Project for a bot's workspace", () => {
    seed('folder:bot-home')
    render(
      <WorktreeRemoveParentMenuItem worktree={worktree} onSelect={() => {}} disabled={false} />
    )
    expect(screen.getByText('Move to Project')).toBeTruthy()
  })

  it('keeps Remove from Parent while bots are turned off', () => {
    catalog.enabled = false
    seed('folder:bot-home')
    render(
      <WorktreeRemoveParentMenuItem worktree={worktree} onSelect={() => {}} disabled={false} />
    )
    expect(screen.getByText('Remove from Parent')).toBeTruthy()
  })

  it('keeps Remove from Parent for any other parent', () => {
    seed('folder:plain')
    render(
      <WorktreeRemoveParentMenuItem worktree={worktree} onSelect={() => {}} disabled={false} />
    )
    expect(screen.getByText('Remove from Parent')).toBeTruthy()
  })
})
