// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import WslMovedProjectsSection from './WslMovedProjectsSection'

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

const initialState = useAppStore.getState()
const declineConfirm = vi.fn(() => Promise.resolve(false))
const uiSet = vi.fn(() => Promise.resolve())

const withChats: WslMovedProject = {
  kind: 'repo',
  id: 'repo-chats',
  displayName: 'with-chats',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\with-chats',
  distro: 'Ubuntu'
}
const withoutChats: WslMovedProject = {
  kind: 'repo',
  id: 'repo-plain',
  displayName: 'plain',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\plain',
  distro: 'Ubuntu'
}

function chat(worktreeId: string): Tab {
  return {
    id: 'chat-1',
    entityId: 'chat-1',
    groupId: 'group-1',
    worktreeId,
    contentType: 'agent-session',
    label: 'Fix the build',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function renderSection() {
  return render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <WslMovedProjectsSection />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
}

const ubuntuHost: PublicKnownRuntimeEnvironment = {
  id: 'wsl-ubuntu',
  name: 'Ubuntu',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'default',
  endpoints: [],
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
}
// The host's own rows of both projects, whose menus keep "Use on this computer again".
const hostRepos = [withChats, withoutChats].map((project) => ({
  ...TEST_REPO,
  id: project.id,
  displayName: project.displayName,
  executionHostId: toRuntimeExecutionHostId(ubuntuHost.id)
}))

beforeEach(() => {
  vi.stubGlobal('api', { ui: { set: uiSet } })
  const worktreeId = `${withChats.id}::/home/me/with-chats`
  useAppStore.setState({
    repos: hostRepos,
    runtimeEnvironments: [ubuntuHost],
    wslMovedProjects: [withChats, withoutChats],
    unifiedTabsByWorktree: { [worktreeId]: [chat(worktreeId)] },
    wslMovedSectionCollapsed: false,
    hiddenWslMovedProjectKeys: []
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  uiSet.mockClear()
  vi.unstubAllGlobals()
})

it('offers Hide only on entries without chats, and a hidden entry stays hidden', () => {
  renderSection()
  expect(screen.getAllByTestId('wsl-moved-project')).toHaveLength(2)
  // The entry with chats has no Hide: it is the only way to them.
  const hideButtons = screen.getAllByTestId('wsl-moved-hide')
  expect(hideButtons).toHaveLength(1)

  act(() => fireEvent.click(hideButtons[0]))

  const entries = screen.getAllByTestId('wsl-moved-project')
  expect(entries).toHaveLength(1)
  expect(entries[0]).toHaveTextContent('with-chats')
})

it('collapses to its header and persists the choice', () => {
  renderSection()
  const toggle = screen.getByTestId('wsl-moved-toggle')
  expect(toggle).toHaveAttribute('aria-expanded', 'true')

  act(() => fireEvent.click(toggle))

  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('with-chats')).not.toBeVisible()
  expect(uiSet).toHaveBeenCalledWith({ wslMovedSectionCollapsed: true })
})

it('disappears once every entry is hidden', () => {
  useAppStore.setState({ wslMovedProjects: [withoutChats], unifiedTabsByWorktree: {} })
  renderSection()
  act(() => fireEvent.click(screen.getByTestId('wsl-moved-hide')))
  expect(screen.queryByTestId('wsl-moved-projects')).toBeNull()
})
