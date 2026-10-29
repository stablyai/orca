// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { WslMoveResultBody } from './WslMoveResultBody'

const movedProject: WslMovedProject = {
  kind: 'folder',
  id: 'notes',
  displayName: 'notes',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\notes',
  distro: 'Ubuntu'
}
// No chats stayed here: the entry must still list, or the result's promise leads nowhere.
const mockState = {
  wslMovedProjects: [movedProject],
  worktreesByRepo: {},
  folderWorkspaces: [],
  unifiedTabsByWorktree: {},
  activeWorktreeId: null,
  activeGroupIdByWorktree: {},
  groupsByWorktree: {},
  // No unsaved file, so the release is not refused before it reaches main.
  openFiles: []
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState }
  )
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))

const { default: WslMovedProjectsSection } = await import('../sidebar/WslMovedProjectsSection')
const { TooltipProvider } = await import('@/components/ui/tooltip')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The sidebar labels the moved result's undo hint quotes, in order. */
function quotedInResult(): string[] {
  const markup = renderToStaticMarkup(
    <WslMoveResultBody
      distro="Ubuntu"
      result={{ outcome: 'moved', migrationId: 'm1', phase: 'retained', reloadRequired: true }}
      blockers={[]}
      reload="idle"
      onReload={() => {}}
      onReview={() => {}}
      onClose={() => {}}
    />
  )
  return [...markup.matchAll(/“([^”]+)”/g)].map((match) => match[1] ?? '')
}

describe('the moved result\'s "Use on this computer again"', () => {
  it('names a sidebar entry and action that exist, and the action asks main to bring it back', async () => {
    const useProjectHereAgain = vi.fn(async () => ({ released: false, reason: 'not-moved' }))
    vi.stubGlobal('api', { wslMove: { useProjectHereAgain } })
    const [entryLabel, actionLabel] = quotedInResult()
    expect([entryLabel, actionLabel]).toEqual([
      'Moved to Ubuntu host',
      'Use on this computer again'
    ])

    render(
      <TooltipProvider>
        <WslMovedProjectsSection />
      </TooltipProvider>
    )
    expect(screen.getByTestId('wsl-moved-project').textContent).toContain(entryLabel)
    fireEvent.click(screen.getByRole('button', { name: actionLabel }))

    await waitFor(() =>
      expect(useProjectHereAgain).toHaveBeenCalledWith({
        kind: 'folder',
        id: 'notes',
        unsavedWorkspaceIds: []
      })
    )
  })
})
