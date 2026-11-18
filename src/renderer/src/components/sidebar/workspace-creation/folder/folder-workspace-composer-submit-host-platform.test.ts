// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({ activateAndRevealFolderWorkspace: vi.fn(), seedDraft: vi.fn() }))

vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock(
  '@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    seedNativeChatLaunchDraftForAgentTab: mocks.seedDraft
  })
)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import '../../../../../../shared/orca-profiles/constants'
import '../../../../../../shared/rpc-contract/workspaces/folder-workspace-params'
import '../../../../../../main/ipc/repos/repo-ipc-arg-schemas'
import '../../../../../../main/runtime/workspaces/startup/runtime-worktree-agent-startup'
import '../../../../../../main/runtime/workspaces/creation/runtime-group-folder-setup'
import { useAppStore } from '@/store/index'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'
import './folder-workspace-agent-startup'

// The owning server’s OS determines agent command quoting.
describe('submitFolderWorkspaceCreate on an Orca server', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  })

  it('refuses an agent launch on an Orca server that never reported its OS', async () => {
    const createFolderWorkspace = vi.fn(async () => ({ folderWorkspace: makeFolderWorkspace() }))
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: { ...makeProjectGroup(), executionHostId: 'runtime:silent-box' },
        name: 'Server folder',
        lastAutoName: '',
        linkedWorkItem: null,
        note: '',
        quickAgent: 'claude',
        autoRenameBranchFromWork: false,
        agentCmdOverrides: {},
        createFolderWorkspace,
        onOpenChange: vi.fn()
      })
    ).rejects.toThrow('has not reported its operating system')
    expect(createFolderWorkspace).not.toHaveBeenCalled()
  })
})
