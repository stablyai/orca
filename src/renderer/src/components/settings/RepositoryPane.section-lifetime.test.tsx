// @vitest-environment happy-dom
import React from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { act, fireEvent } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  settingsSearchQuery: 'github',
  settings: null,
  repos: [],
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  agentStatusByPaneKey: {},
  worktreeVisibilityDefaultsByHost: {},
  fetchWorktrees: vi.fn()
}
const bridge = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/runtime-hooks-client', () => ({
  readRuntimeIssueCommand: bridge.read,
  writeRuntimeIssueCommand: bridge.write
}))
vi.mock('./RepositoryHookScriptSetting', () => ({
  LocalCommandSourceNotice: () => null,
  RepositoryHookScriptSetting: () => null
}))
vi.mock('./RepositoryHookPolicySettings', () => ({
  RepositoryHookCommandSourceSetting: () => null,
  RepositorySetupPolicySetting: () => null
}))
vi.mock('./McpConfigSection', () => ({
  McpConfigSection: () => null
}))
vi.mock('./WorktreeSymlinksSection', () => ({
  WorktreeSymlinksSection: () => null
}))
vi.mock('./SparsePresetSettingsSection', () => ({
  SparsePresetSettingsSection: () => null
}))
vi.mock('./RepositorySourceControlAiSection', () => ({
  RepositorySourceControlAiSection: () => null
}))
vi.mock('./RepositoryHostSetupsSection', () => ({
  RepositoryHostSetupsSection: () => null
}))
vi.mock('./RepositoryWindowsRuntimeSection', () => ({
  RepositoryWindowsRuntimeSection: () => null
}))
vi.mock('./RepositoryForkSyncSection', () => ({
  RepositoryForkSyncSection: () => null
}))
vi.mock('./RepositoryGitHubAccountSection', () => ({
  RepositoryGitHubAccountSection: () => null
}))
vi.mock('./RepositoryWorktreeDefaultsSection', () => ({
  RepositoryWorktreeDefaultsSection: () => null
}))
vi.mock('./RepositoryIconPicker', () => ({
  RepositoryIconPicker: () => null
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('../ui/button', () => ({ Button: () => null }))
vi.mock('../ui/label', () => ({ Label: () => null }))
vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { RepositoryPane } from './RepositoryPane'

describe('RepositoryPane section lifetime', () => {
  const local: Repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'Example Repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git'
  }
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const updateRepo = vi.fn()
  const removeProject = vi.fn()
  async function render(repo = local) {
    await act(async () => {
      root.render(
        <RepositoryPane
          repo={repo}
          yamlHooks={null}
          hasHooksFile={false}
          hooksInspectionReady
          mayNeedUpdate={false}
          updateRepo={updateRepo}
          removeProject={removeProject}
        />
      )
    })
  }
  function issueTextarea() {
    const textarea = container.querySelector('textarea[aria-label="Custom GitHub Issue Command"]')
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('Issue command textarea absent')
    }
    return textarea
  }
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.read.mockResolvedValue({ localContent: 'saved issue command', sharedContent: null })
    bridge.write.mockResolvedValue(undefined)
    state.settingsSearchQuery = 'github'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  it.each(['local', 'ssh:review-host'] as const)(
    'preserves the issue-command section while earlier identity filters for %s',
    async (executionHostId) => {
      const repo = { ...local, executionHostId }
      await render(repo)
      const firstTextarea = issueTextarea()
      expect(bridge.read).toHaveBeenCalledExactlyOnceWith(
        { activeRuntimeEnvironmentId: null },
        repo.id,
        executionHostId
      )
      expect(container.textContent).toContain('Identity')
      state.settingsSearchQuery = 'issue command'
      await render(repo)
      expect(container.textContent).not.toContain('Identity')
      expect(issueTextarea()).toBe(firstTextarea)
      expect(bridge.read).toHaveBeenCalledTimes(1)
      expect(bridge.write).not.toHaveBeenCalled()
      expect(updateRepo).not.toHaveBeenCalled()
    }
  )
  it('preserves a dirty issue-command draft without an incidental save while search matches', async () => {
    await render()
    const textarea = issueTextarea()
    act(() => fireEvent.change(textarea, { target: { value: 'draft issue command' } }))
    expect(textarea.value).toBe('draft issue command')
    state.settingsSearchQuery = 'issue command'
    await render()
    expect(issueTextarea()).toBe(textarea)
    expect(issueTextarea().value).toBe('draft issue command')
    expect(bridge.read).toHaveBeenCalledTimes(1)
    expect(bridge.write).not.toHaveBeenCalled()
  })
  it('unmounts and reloads hooks after the section actually hides', async () => {
    state.settingsSearchQuery = 'issue command'
    await render()
    const textarea = issueTextarea()
    state.settingsSearchQuery = 'display name'
    await render()
    expect(container.querySelector('textarea')).toBeNull()
    state.settingsSearchQuery = 'issue command'
    await render()
    expect(issueTextarea()).not.toBe(textarea)
    expect(bridge.read).toHaveBeenCalledTimes(2)
    expect(bridge.write).not.toHaveBeenCalled()
  })
  it('preserves ordering and separators as the first visible section changes', async () => {
    await render()
    const textarea = issueTextarea()
    expect(container.querySelectorAll('[data-slot="separator"]')).toHaveLength(1)
    state.settingsSearchQuery = 'issue command'
    await render()
    expect(container.querySelectorAll('[data-slot="separator"]')).toHaveLength(0)
    state.settingsSearchQuery = 'github'
    await render()
    expect(container.querySelectorAll('[data-slot="separator"]')).toHaveLength(1)
    expect(container.textContent!.indexOf('Identity')).toBeLessThan(
      container.textContent!.indexOf('Worktree Hooks')
    )
    expect(issueTextarea()).toBe(textarea)
  })
  it('keeps the actual hook subtree and read when the wrapper index stays zero', async () => {
    state.settingsSearchQuery = 'issue command'
    await render()
    const firstTextarea = issueTextarea()
    state.settingsSearchQuery = 'workflow'
    await render()
    expect(issueTextarea()).toBe(firstTextarea)
    expect(bridge.read).toHaveBeenCalledTimes(1)
    expect(bridge.write).not.toHaveBeenCalled()
  })
  it('does not mount Git hooks for a folder project', async () => {
    await render({ ...local, kind: 'folder' })
    state.settingsSearchQuery = 'issue command'
    await render({ ...local, kind: 'folder' })
    expect(bridge.read).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })
})
