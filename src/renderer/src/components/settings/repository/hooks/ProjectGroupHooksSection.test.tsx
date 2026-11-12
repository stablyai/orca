// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../../__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import { ProjectGroupHooksSection } from './ProjectGroupHooksSection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'

vi.mock('@/lib/workspace/creation/setup/folder-setup-support', () => ({
  useFolderSetupSupport: () => 'supported'
}))
vi.mock('@/components/sidebar/workspace-creation/folder/folder-workspace-agent-startup', () => ({
  getFolderWorkspaceAgentLaunchFact: () => ({ kind: 'known', platform: 'darwin' })
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({ checkRuntimeGroupHooks: vi.fn() }))

it('loads owner-host settings and inserts/copies the real-repo example without overwriting archive settings', async () => {
  const group = {
    ...createProjectGroup({
      name: 'Services',
      parentPath: '/srv/services',
      createdFrom: 'folder-scan',
      tabOrder: 0
    }),
    id: 'services',
    executionHostId: 'runtime:owner' as const
  }
  const saved = {
    mode: 'auto' as const,
    setupRunPolicy: 'run-by-default' as const,
    commandSourcePolicy: 'local-only' as const,
    scripts: { setup: 'echo saved on owner', archive: 'echo keep archive' },
    setupAgentStartupPolicy: 'wait-for-setup' as const
  }
  vi.mocked(checkRuntimeGroupHooks).mockResolvedValue({
    status: 'ok',
    hasHooks: false,
    hooks: null,
    hookSettings: saved,
    mayNeedUpdate: false,
    setupRunPolicy: 'run-by-default',
    setupConfig: null
  })
  const updateProjectGroup = vi.fn(async () => true)
  const writeClipboardText = vi.fn(async () => {})
  window.api.ui.writeClipboardText = writeClipboardText
  useAppStore.setState({
    settingsSearchQuery: '',
    projectGroups: [group],
    repos: [
      {
        id: 'api',
        path: '/srv/services/api',
        displayName: 'API server',
        badgeColor: '#111',
        addedAt: 1,
        executionHostId: 'runtime:owner'
      },
      {
        id: 'web',
        path: '/srv/services/web',
        displayName: 'Website',
        badgeColor: '#111',
        addedAt: 1,
        executionHostId: 'runtime:owner'
      },
      {
        id: 'local',
        path: '/srv/services/local',
        displayName: 'Other host',
        badgeColor: '#111',
        addedAt: 1
      }
    ],
    updateProjectGroup
  })
  render(
    <TooltipProvider>
      <ProjectGroupHooksSection group={group} />
    </TooltipProvider>
  )
  await waitFor(() => expect(screen.getByDisplayValue('echo saved on owner')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Use this example' }))
  await waitFor(() => expect(updateProjectGroup).toHaveBeenCalled())
  const script =
    '# Repo IDs are local to this machine; review them before sharing this script.\n# API server\norca worktree create --repo \'id:api\' --name "$ORCA_WORKSPACE_NAME" --json\n# Website\norca worktree create --repo \'id:web\' --name "$ORCA_WORKSPACE_NAME" --json'
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'services',
    { hookSettings: { ...saved, scripts: { setup: script, archive: 'echo keep archive' } } },
    { hostId: 'runtime:owner' }
  )
  const exampleActions = screen.getByRole('button', { name: 'Use this example' }).parentElement!
  fireEvent.click(within(exampleActions).getByRole('button', { name: /^Copy$/ }))
  expect(writeClipboardText).toHaveBeenCalledWith(script)
  expect(checkRuntimeGroupHooks).toHaveBeenCalledWith('runtime:owner', 'services', {
    background: true
  })
})
