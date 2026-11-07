// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as SourceRepos from '../../../../shared/folder-workspaces/folder-workspace-source-repos'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { FolderWorkspaceEmptyState } from './folder-workspace-empty-state'

const counts = vi.hoisted(() => ({ scans: 0, scannedRepos: 0 }))
vi.mock('../../../../shared/folder-workspaces/folder-workspace-source-repos', async (original) => {
  const actual = await original<typeof SourceRepos>()
  return {
    ...actual,
    getFolderSourceRepos: (...args: Parameters<typeof actual.getFolderSourceRepos>) => {
      counts.scans++
      counts.scannedRepos += args[0].length
      return actual.getFolderSourceRepos(...args)
    }
  }
})

const repo = (index: number, path = `/repo/platform/service-${index}`): Repo => ({
  id: `repo-${index}`,
  path,
  displayName: `service-${index}`,
  badgeColor: 'blue',
  addedAt: 1
})

/** Half the catalog sits outside the folder, as in a real multi-project install. */
function catalog(size: number): Repo[] {
  return Array.from({ length: size }, (_, index) =>
    repo(index, index % 2 === 0 ? `/repo/platform/service-${index}` : `/elsewhere/service-${index}`)
  )
}

const folderWorkspace = makeFolderWorkspace()

/** Like the three panels: re-renders on worktree activity and passes the same folder record. */
function Panel({ folder = folderWorkspace }: { folder?: FolderWorkspace }): React.JSX.Element {
  useAppStore((s) => s.activeWorktreeId)
  useAppStore((s) => s.worktreesByRepo)
  return (
    <FolderWorkspaceEmptyState
      folderWorkspace={folder}
      title="No attached worktrees yet"
      copy="Worktrees created from this workspace will show up here."
    />
  )
}

function mount(): ReturnType<typeof render> {
  return render(<Panel />)
}

function resetCounts(): void {
  counts.scans = 0
  counts.scannedRepos = 0
}

describe('folder empty-state repository rows at catalog scale', () => {
  const initial = useAppStore.getState()

  beforeEach(() => {
    useAppStore.setState({ projectGroups: [makeProjectGroup()] })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initial, true)
  })

  it.each([100, 1_000])(
    'scans the catalog once per catalog change and never when the panel re-renders for worktree activity (%i repos)',
    (size) => {
      useAppStore.setState({ repos: catalog(size) })
      const view = mount()
      resetCounts()

      act(() => useAppStore.setState({ activeWorktreeId: 'unrelated' }))
      act(() => useAppStore.setState({ worktreesByRepo: { 'repo-0': [] } }))
      // Activity bumps replace the folder record without touching its group or host.
      view.rerender(<Panel folder={{ ...folderWorkspace, lastActivityAt: 2 }} />)
      expect(counts.scans).toBe(0)
      expect(counts.scannedRepos).toBe(0)

      act(() => useAppStore.setState({ repos: [...catalog(size), repo(size)] }))
      // One pass over the new catalog is the required work: each repo's membership must be decided.
      expect(counts.scans).toBe(1)
      expect(counts.scannedRepos).toBe(size + 1)
      expect(view.getByText(`service-${size}`)).toBeTruthy()
    }
  )
})
