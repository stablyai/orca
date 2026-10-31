// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../../../shared/project-types'
import { RepositoryWindowsRuntimeSection } from './RepositoryWindowsRuntimeSection'

const state = vi.hoisted(() => ({
  settingsSearchQuery: '',
  settings: { experimentalWslHosts: true },
  wslHostsAcceptNewWork: true
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('../../../wsl-move/wsl-move-entry', () => ({ useWslMoveTargetForRepo: () => null }))
vi.mock('../../ProjectWindowsRuntimeSetting', () => ({
  ProjectWindowsRuntimeSetting: () => <div>runtime</div>
}))
vi.mock('../../../wsl-drive-project/WslDriveProjectGitRow', () => ({
  WslDriveProjectGitRow: () => <div>windows-git-row</div>
}))
vi.mock('../../../wsl-drive-project/WslDriveUncConversionRow', () => ({
  WslDriveUncConversionRow: () => <div>unc-conversion-row</div>
}))

const repo = { id: 'repo-1', path: 'C:\\src\\app', connectionId: null, kind: 'git' as const }
const project: Project = {
  id: 'project-1',
  displayName: 'app',
  badgeColor: '',
  sourceRepoIds: ['repo-1'],
  createdAt: 0,
  updatedAt: 0
}

function renderSection(): void {
  render(
    <RepositoryWindowsRuntimeSection
      repo={repo}
      repoDisplayName="app"
      project={project}
      settings={{ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } }}
      isLocalWindowsProject
      wslAvailable
      wslDistros={['Ubuntu']}
      wslCapabilitiesLoading={false}
      updateProject={vi.fn()}
      forceVisible
      searchQuery=""
      searchEntries={[]}
    />
  )
}

describe('RepositoryWindowsRuntimeSection D1c rows', () => {
  beforeEach(() => {
    state.settings = { experimentalWslHosts: true }
    state.wslHostsAcceptNewWork = true
    Object.assign(window, { api: { runtimeEnvironments: { wslHosts: {} } } })
  })
  afterEach(() => cleanup())

  it('shows the Windows-drive Git and drive-path rows when WSL hosts take new work', () => {
    renderSection()
    expect(screen.getByText('windows-git-row')).toBeTruthy()
    expect(screen.getByText('unc-conversion-row')).toBeTruthy()
  })

  // Main refuses these conversions in each case; a row that stays would only fail on click.
  it.each([
    ['serve-only or a live policy block', () => (state.wslHostsAcceptNewWork = false)],
    ['the WSL hosts setting off', () => (state.settings = { experimentalWslHosts: false })]
  ])('hides both rows with %s', (_case, stop) => {
    stop()
    renderSection()
    expect(screen.queryByText('windows-git-row')).toBeNull()
    expect(screen.queryByText('unc-conversion-row')).toBeNull()
    expect(screen.getByText('runtime')).toBeTruthy()
  })
})
