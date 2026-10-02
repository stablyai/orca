import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SourceControlAgentLaunchModule from '@/lib/source-control-agent-launch'

const mocks = vi.hoisted(() => ({
  launchSourceControlAgent: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  showNotDelivered: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/source-control-agent-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlAgentLaunchModule>()),
  launchSourceControlAgent: mocks.launchSourceControlAgent
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchPromptNotDeliveredNotice: mocks.showNotDelivered
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() }
}))

import type { TuiAgent } from '../../../../../../shared/tui-agent'
import {
  getDefaultSourceControlRecoveryLaunchCopy,
  launchSourceControlRecoveryAgentWithDefault
} from './recovery-launch'

const COPY = getDefaultSourceControlRecoveryLaunchCopy('commit')
const DETECTED: TuiAgent[] = ['claude']

function launch() {
  return launchSourceControlRecoveryAgentWithDefault({
    activeWorktreeId: 'wt-1',
    activeGroupId: 'group-1',
    activeSourceControlLaunchPlatform: 'darwin',
    actionId: 'fixCommitFailure',
    basePrompt: 'The commit failed:\nhook output',
    getLaunchActionRecipe: () => ({ agentArgs: '--model opus' }),
    getStoreState: () => ({
      settings: null,
      ensureDetectedAgents: async () => DETECTED,
      ensureRemoteDetectedAgents: async () => DETECTED
    }),
    copy: COPY
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commit-failure recovery on a host that takes the launch', () => {
  it('hands the host the recovery prompt under its own launch source', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'launched', promptDelivered: true })

    await expect(launch()).resolves.toBe(true)

    expect(mocks.launchSourceControlAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        agentArgs: '--model opus',
        launchSource: 'source_control_recovery',
        prompt: expect.stringContaining('The commit failed:\nhook output')
      })
    )
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith(COPY.success)
  })

  it('claims no success when the host kept the prompt, and hands it over instead', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'launched', promptDelivered: false })

    await expect(launch()).resolves.toBe(true)

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.showNotDelivered).toHaveBeenCalledOnce()
  })

  it('uses the tab paste on a host without the launch', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'unsupported' })
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' }
    })

    await expect(launch()).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ promptDelivery: 'submit-after-ready', launchPlatform: 'darwin' })
    )
  })
})
