// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import {
  WslMovedRepoUseHereMenuItem,
  WslMovedWorkspaceUseHereMenuItem
} from './WslMovedUseHereMenuItem'

const initialState = useAppStore.getState()
const declineConfirm = vi.fn(() => Promise.resolve(false))

function wslHost(distro: string): PublicKnownRuntimeEnvironment {
  return {
    id: `wsl-${distro}`,
    name: distro,
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'default',
    endpoints: [],
    orcadDeployment: { kind: 'wsl', distro, localPort: 4100, remotePort: 4200 }
  }
}
const UBUNTU = toRuntimeExecutionHostId('wsl-Ubuntu')
const DEBIAN = toRuntimeExecutionHostId('wsl-Debian')

const movedRepo: WslMovedProject = {
  kind: 'repo',
  id: 'repo-1',
  displayName: 'app',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
  distro: 'Ubuntu'
}
const movedFolder: WslMovedProject = {
  kind: 'folder',
  id: 'folder-1',
  displayName: 'notes',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes',
  distro: 'Ubuntu'
}

function renderInOpenMenu(item: React.ReactNode) {
  return render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>{item}</DropdownMenuContent>
      </DropdownMenu>
    </ConfirmationDialogContext.Provider>
  )
}

const undoItem = () => screen.queryByRole('menuitem', { name: 'Use on this computer again' })

beforeEach(() => {
  useAppStore.setState({
    wslMovedProjects: [movedRepo, movedFolder],
    runtimeEnvironments: [wslHost('Debian'), wslHost('Ubuntu')],
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'notes',
        folderPath: '/home/me/notes',
        executionHostId: UBUNTU,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    // The same repo id on both hosts, Debian's listed first.
    repos: [
      { ...TEST_REPO, id: 'repo-1', executionHostId: DEBIAN },
      { ...TEST_REPO, id: 'repo-1', executionHostId: UBUNTU }
    ]
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('Undo in a workspace right-click menu', () => {
  it("follows the clicked workspace's host, not the first registration of its repo", () => {
    const view = renderInOpenMenu(
      <WslMovedWorkspaceUseHereMenuItem worktree={{ id: 'repo-1::/home/me/app', hostId: DEBIAN }} />
    )
    expect(undoItem()).toBeNull()
    view.unmount()
    renderInOpenMenu(
      <WslMovedWorkspaceUseHereMenuItem worktree={{ id: 'repo-1::/home/me/app', hostId: UBUNTU }} />
    )
    expect(undoItem()).toBeInTheDocument()
  })

  it("offers a moved folder's undo on its host's folder row", () => {
    renderInOpenMenu(
      <WslMovedWorkspaceUseHereMenuItem worktree={{ id: 'folder:folder-1', hostId: UBUNTU }} />
    )
    expect(undoItem()).toBeInTheDocument()
  })

  it('offers nothing on a row whose host is unknown', () => {
    renderInOpenMenu(<WslMovedWorkspaceUseHereMenuItem worktree={{ id: 'repo-1::/home/me/app' }} />)
    expect(undoItem()).toBeNull()
  })
})

describe('Undo in a project header menu', () => {
  it("shows on the moved-to host's row and not on another host's row of the same id", () => {
    const view = renderInOpenMenu(
      <WslMovedRepoUseHereMenuItem repo={{ ...TEST_REPO, id: 'repo-1', executionHostId: DEBIAN }} />
    )
    expect(undoItem()).toBeNull()
    view.unmount()
    renderInOpenMenu(
      <WslMovedRepoUseHereMenuItem repo={{ ...TEST_REPO, id: 'repo-1', executionHostId: UBUNTU }} />
    )
    expect(undoItem()).toBeInTheDocument()
  })
})
