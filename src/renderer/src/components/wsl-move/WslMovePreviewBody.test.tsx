// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslMovePreview } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { WslMovePreviewBody, wslMoveNotMovingLines } from './WslMovePreviewBody'

afterEach(cleanup)

const names: Record<string, string> = { app: 'app', notes: 'notes' }

function renderPreview(preview: WslMovePreview): void {
  render(
    <WslMovePreviewBody
      distro="Ubuntu"
      rows={[]}
      selected={[]}
      counts={{ projects: 0, workspaces: 0, terminals: 0, chats: 0 }}
      preview={preview}
      notMoving={wslMoveNotMovingLines(preview, (ref) => names[ref.id] ?? ref.id, 'Ubuntu')}
      blockers={[]}
      onToggle={vi.fn()}
      onSkip={vi.fn()}
      onRecheck={vi.fn()}
      onStart={vi.fn()}
      onClose={vi.fn()}
    />
  )
}

describe('WslMovePreviewBody', () => {
  it('says why when the only candidate is a repo the host Git cannot take', () => {
    renderPreview({
      outcome: 'refused',
      code: 'wsl_move_nothing_new',
      refused: [{ kind: 'repo', id: 'app', reason: 'windows-git-worktrees' }]
    })
    expect(screen.getByText(/Git for Windows recorded some of its worktrees/)).toBeVisible()
    expect(screen.getByText(/None of these projects can move/)).toBeVisible()
    expect(screen.queryByText(/already on the Ubuntu host/)).toBeNull()
  })

  it('lists a project whose drive did not answer under "Not moving"', () => {
    renderPreview({
      outcome: 'ready',
      distro: 'Ubuntu',
      repoIds: [],
      folderWorkspaceIds: [],
      changed: [],
      heldByHost: [],
      refused: [{ kind: 'folder-workspace', id: 'notes', reason: 'mapped-drive-unverifiable' }],
      blockers: []
    })
    expect(screen.getByText('notes')).toBeVisible()
    expect(screen.getByText(/couldn’t check where its drive letter points/)).toBeVisible()
  })
})
