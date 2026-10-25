// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { WorkspaceSpaceTreemap } from './workspace-space-treemap'

const worktree: WorkspaceSpaceWorktree = {
  worktreeId: 'repo::/workspace',
  repoId: 'repo',
  executionHostId: 'local',
  repoDisplayName: 'repo',
  repoPath: '/repo',
  displayName: 'workspace',
  path: '/workspace',
  branch: 'main',
  isMainWorktree: false,
  isRemote: false,
  isSparse: false,
  canDelete: true,
  lastActivityAt: 0,
  status: 'ok',
  error: null,
  scannedAt: 0,
  sizeBytes: 4096,
  reclaimableBytes: 4096,
  skippedEntryCount: 0,
  topLevelItems: [
    { name: 'node_modules', path: '/workspace/node_modules', kind: 'directory', sizeBytes: 3072 }
  ],
  omittedTopLevelItemCount: 0,
  omittedTopLevelSizeBytes: 0
}

function TreemapHarness(): React.JSX.Element {
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [zoomId, setZoomId] = useState<string | null>(null)
  return (
    <WorkspaceSpaceTreemap
      rows={[worktree]}
      isScanning={false}
      selectedWorktreeId={selectedWorktreeId}
      zoomedWorktree={zoomId === getWorkspaceSpaceWorktreeIdentity(worktree) ? worktree : null}
      onSelect={setSelectedWorktreeId}
      onZoomChange={setZoomId}
    />
  )
}

afterEach(cleanup)

describe('WorkspaceSpaceTreemap', () => {
  it('opens a workspace from its tile and returns to the overview', () => {
    render(<TreemapHarness />)

    fireEvent.click(screen.getByRole('button', { name: /workspace, 4/ }))
    expect(screen.getByText('Folder sizes')).toBeTruthy()
    expect(screen.getByText('node_modules')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Click a workspace to zoom')).toBeTruthy()
  })
})
