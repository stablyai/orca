// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_WALL_SETUP_STEPS } from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from './feature-wall-setup-progress'
import { FeatureWallSetupChecklist } from './FeatureWallSetupChecklist'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: {} })
}))

vi.mock('../settings/CliSection', () => ({
  CliSection: () => <div data-testid="cli-section" />
}))

vi.mock('./FullDiskAccessSetupPrompt', () => ({ FullDiskAccessSetupPrompt: () => null }))
vi.mock('./AgentCapabilitiesSetupAction', () => ({ AgentCapabilitiesSetupAction: () => null }))
vi.mock('./ConnectIntegrationsList', () => ({ ConnectIntegrationsList: () => null }))
vi.mock('./FeatureWallBrowserAction', () => ({ BrowserAction: () => null }))
vi.mock('./FeatureWallSetupWorkflowActions', () => ({
  AddReposAction: () => null,
  SetupScriptAction: () => null,
  WorkspacesAction: () => null
}))
vi.mock('../onboarding/AgentStep', () => ({ AgentStep: () => null }))
vi.mock('../onboarding/NotificationStep', () => ({ NotificationStep: () => null }))

const progress: FeatureWallSetupProgress = {
  ready: true,
  stepDone: {
    'default-agent': false,
    'add-two-repos': false,
    notifications: false,
    'two-worktrees': false,
    browser: false,
    'task-sources': false,
    'agent-capabilities': false,
    'cli-setup': false,
    'setup-script': false
  },
  coreDoneCount: 0,
  coreTotal: FEATURE_WALL_SETUP_STEPS.length
}

describe('FeatureWallSetupChecklist CLI setup step', () => {
  it('lists the CLI step in Setup and renders the CLI section as its action', () => {
    const activeStep = FEATURE_WALL_SETUP_STEPS.find((step) => step.id === 'cli-setup')
    if (!activeStep) {
      throw new Error('cli-setup step definition is missing')
    }

    render(
      <FeatureWallSetupChecklist
        activeStep={activeStep}
        progress={progress}
        onSelectStep={vi.fn()}
        onOrchestrationSkillInstalledChange={vi.fn()}
        onBrowserUseSkillInstalledChange={vi.fn()}
      />
    )

    // Rail row + pane title.
    expect(screen.getAllByText('Set up the Orca CLI')).toHaveLength(2)
    expect(screen.getByTestId('cli-section')).not.toBeNull()
  })
})
