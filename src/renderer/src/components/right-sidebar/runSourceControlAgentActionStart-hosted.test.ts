import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SourceControlAgentLaunchModule from '@/lib/source-control-agent-launch'

const mocks = vi.hoisted(() => ({
  launchSourceControlAgent: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  showNotDelivered: vi.fn(),
  onLaunchAccepted: vi.fn(),
  onLaunchAborted: vi.fn(),
  onLaunched: vi.fn(),
  onClose: vi.fn(),
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
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, warning: vi.fn() } }))

import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'

function buildArgs(
  overrides: Partial<Parameters<typeof runSourceControlAgentActionStart>[0]> = {}
): Parameters<typeof runSourceControlAgentActionStart>[0] {
  return {
    selectedAgent: 'claude',
    trimmedCommandInput: 'Resolve the conflicts.\nFiles: a.ts',
    agentArgs: '--model opus',
    agentArgsApply: true,
    commandTemplate: '{basePrompt}',
    saveTargetValue: 'none',
    actionId: 'resolveConflicts',
    repoId: null,
    settings: null,
    repo: null,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    promptDelivery: 'submit-after-ready',
    launchPlatform: 'linux',
    launchSource: 'conflict_resolution',
    onLaunchAccepted: mocks.onLaunchAccepted,
    onLaunchAborted: mocks.onLaunchAborted,
    onLaunched: mocks.onLaunched,
    onClose: mocks.onClose,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a source-control action started through the host', () => {
  it('asks the host for this agent, workspace and prompt', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'launched', promptDelivered: true })

    await runSourceControlAgentActionStart(buildArgs())

    expect(mocks.launchSourceControlAgent).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'Resolve the conflicts.\nFiles: a.ts',
      agentArgs: '--model opus',
      launchSource: 'conflict_resolution',
      onLaunchAccepted: expect.any(Function)
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('confirms the launch only once the host delivered the prompt', async () => {
    mocks.launchSourceControlAgent.mockImplementation(async (args) => {
      args.onLaunchAccepted()
      return { kind: 'launched', promptDelivered: true }
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(true)

    expect(mocks.onLaunchAccepted).toHaveBeenCalledOnce()
    expect(mocks.onLaunched).toHaveBeenCalledOnce()
    expect(mocks.onLaunchAborted).not.toHaveBeenCalled()
  })

  it('aborts the caller’s follow-ups and hands over the prompt when the host kept it', async () => {
    mocks.launchSourceControlAgent.mockImplementation(async (args) => {
      args.onLaunchAccepted()
      return { kind: 'launched', promptDelivered: false }
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.onLaunchAborted).toHaveBeenCalledOnce()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.showNotDelivered).toHaveBeenCalledOnce()
    // The notice already told the user; a second "could not start" would be false.
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('omits the arguments when they do not apply, so the host uses the settings default', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'launched', promptDelivered: true })

    await runSourceControlAgentActionStart(buildArgs({ agentArgsApply: false }))

    expect(mocks.launchSourceControlAgent.mock.calls[0]?.[0]).not.toHaveProperty('agentArgs')
  })

  it('uses the tab paste on a host without the launch', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'unsupported' })
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledOnce()
  })

  it('keeps a draft on the tab paste, which the host has no way to deliver', async () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    await runSourceControlAgentActionStart(buildArgs({ promptDelivery: 'draft' }))

    expect(mocks.launchSourceControlAgent).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledOnce()
  })

  it('reports a refused launch once, with the host’s reason', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'failed', message: 'Agent disabled' })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't start the agent.", {
      description: 'Agent disabled'
    })
  })
})
