import { describe, expect, it } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import {
  buildDismissedOnboardingFolderAgentStartup,
  buildOnboardingFolderAgentStartup,
  shouldSeedFolderAgentAfterDismissedOnboarding
} from '@/lib/onboarding-folder-agent-startup'

describe('buildOnboardingFolderAgentStartup', () => {
  it('queues the persisted default agent with onboarding telemetry', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex'
    })

    expect(startup).toEqual({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('respects the blank terminal preference', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'blank'
    })

    expect(startup).toBeUndefined()
  })

  it('does not infer an agent from auto mode', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: null
    })

    expect(startup).toBeUndefined()
  })

  it('seeds after a dismissed onboarding run before any project was added', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        false
      )
    ).toBe(true)
  })

  it('does not seed after another project was already added outside onboarding', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        true
      )
    ).toBe(false)
  })

  it('does not seed after onboarding already added a project', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed',
          checklist: { ...getDefaultOnboardingState().checklist, addedFolder: true }
        },
        false
      )
    ).toBe(false)
  })

  it('builds the skipped-onboarding folder startup from the persisted default agent', () => {
    expect(
      buildDismissedOnboardingFolderAgentStartup(
        {
          ...getDefaultSettings('/tmp/orca-workspaces'),
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: 'echo onboarding-folder-agent' }
        },
        { ...getDefaultOnboardingState(), outcome: 'dismissed' },
        false
      )
    ).toEqual({
      command: "echo onboarding-folder-agent '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })
})
