// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserAction } from './FeatureWallBrowserAction'
import { AgentCapabilitiesSetupAction } from './AgentCapabilitiesSetupAction'
import type * as AgentCapabilitySetupStatusModule from './agent-capability-setup-status'
import type * as OnboardingFeatureSetupModule from '../onboarding/onboarding-feature-setup'

const mocks = vi.hoisted(() => ({
  runSetup: vi.fn(),
  runtime: {
    agentRuntime: {
      runtime: 'host' as const,
      runtimeOwnershipResolved: false,
      label: 'This device'
    },
    installDisabledReason: null,
    canUseLocalSkillFreshness: false
  }
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.runtime
}))

vi.mock('../onboarding/onboarding-feature-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof OnboardingFeatureSetupModule>()),
  runOnboardingFeatureSetup: mocks.runSetup
}))

vi.mock('./agent-capability-setup-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentCapabilitySetupStatusModule>()),
  useAgentCapabilitySetupStatus: () => ({
    readiness: {
      browserUseSkillInstalled: false,
      browserUseSkillLoading: false,
      computerUseSkillInstalled: false,
      computerUseSkillLoading: false,
      computerUseReady: false,
      computerUseChecking: false,
      computerUseUnavailable: false,
      orchestrationSkillInstalled: false,
      orchestrationSkillLoading: false
    },
    installStatus: {
      browserUse: { label: 'Pending', tone: 'pending' },
      computerUse: { label: 'Pending', tone: 'pending' },
      orchestration: { label: 'Pending', tone: 'pending' },
      linearTickets: { label: '', tone: 'pending' }
    }
  })
}))

vi.mock('./FeatureWallSetupWorkflowActions', () => ({
  promptForSetupGuideProject: vi.fn(),
  useSetupTargetWorktree: () => null
}))

vi.mock('./FullDiskAccessSetupPrompt', () => ({
  FullDiskAccessSetupPrompt: () => null
}))

vi.mock('../onboarding/FeatureSetupInlineTerminal', () => ({
  FeatureSetupInlineTerminal: () => null
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

describe('feature-wall skill setup runtime authority', () => {
  beforeEach(() => {
    mocks.runSetup.mockReset()
    mocks.runSetup.mockResolvedValue({
      computerUsePermissionsOpened: false,
      skillCommandsCopied: false,
      skillInstallCommand: null,
      warnings: []
    })
    Object.assign(mocks.runtime.agentRuntime, {
      runtimeEnvironmentId: undefined,
      runtimeOwnershipResolved: false
    })
  })

  afterEach(() => cleanup())

  it('defers browser setup until an exact paired owner resolves', async () => {
    const rendered = render(<BrowserAction done />)
    const button = screen.getByRole('button', { name: 'Install CLI & Skill' })

    expect((button as HTMLButtonElement).disabled).toBe(true)
    button.click()
    expect(mocks.runSetup).not.toHaveBeenCalled()

    Object.assign(mocks.runtime.agentRuntime, {
      runtimeEnvironmentId: 'linux-host',
      runtimeOwnershipResolved: true
    })
    rendered.rerender(<BrowserAction done />)
    await act(async () => screen.getByRole('button', { name: 'Install CLI & Skill' }).click())

    expect(mocks.runSetup).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      expect.objectContaining({
        agentRuntime: expect.objectContaining({ runtimeEnvironmentId: 'linux-host' })
      })
    )
  })

  it('defers capability setup until the local owner resolves', async () => {
    const rendered = render(
      <AgentCapabilitiesSetupAction
        onBrowserUseSkillInstalledChange={vi.fn()}
        onOrchestrationSkillInstalledChange={vi.fn()}
      />
    )
    const button = screen.getByRole('button', { name: 'Install CLI & Skills' })

    expect((button as HTMLButtonElement).disabled).toBe(true)
    button.click()
    expect(mocks.runSetup).not.toHaveBeenCalled()

    Object.assign(mocks.runtime.agentRuntime, {
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true
    })
    rendered.rerender(
      <AgentCapabilitiesSetupAction
        onBrowserUseSkillInstalledChange={vi.fn()}
        onOrchestrationSkillInstalledChange={vi.fn()}
      />
    )
    await act(async () => screen.getByRole('button', { name: 'Install CLI & Skills' }).click())

    expect(mocks.runSetup).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      expect.objectContaining({
        agentRuntime: expect.objectContaining({ runtimeEnvironmentId: null })
      })
    )
  })
})
