import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import {
  buildOnboardingFolderAgentStartup,
  shouldSeedFolderAgentAfterDismissedOnboarding
} from '@/lib/onboarding-folder-agent-startup'

const HOST = { platform: 'linux', shell: undefined, isRemote: false } as const
const buildStartup = (settings: Parameters<typeof buildOnboardingFolderAgentStartup>[0]) =>
  buildOnboardingFolderAgentStartup(settings, HOST)

describe('buildOnboardingFolderAgentStartup', () => {
  it('queues the persisted default agent with onboarding telemetry', () => {
    const startup = buildStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex'
    })

    expect(startup).toEqual({
      command: "codex '-c' 'disable_paste_burst=true' '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      sessionOptions: undefined,
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('respects the blank terminal preference', () => {
    const startup = buildStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'blank'
    })

    expect(startup).toBeUndefined()
  })

  it.each([false, true])(
    'keeps Chat UI model preferences out of the terminal folder launch (Chat UI %s)',
    (experimentalNativeChat) => {
      const startup = buildStartup({
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex',
        experimentalNativeChat,
        nativeChatSessionOptions: {
          codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
          }
        }
      })

      expect(startup?.command).not.toContain("'-m'")
      expect(startup?.command).not.toContain('model_reasoning_effort=')
      expect(startup).not.toHaveProperty('sessionOptions')
    }
  )

  it('does not infer an agent from auto mode', () => {
    const startup = buildStartup({
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
})
