import { describe, expect, it } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import {
  buildDismissedOnboardingFolderAgentStartup,
  buildOnboardingFolderAgentStartup,
  shouldSeedFolderAgentAfterDismissedOnboarding
} from '@/lib/onboarding-folder-agent-startup'

describe('buildOnboardingFolderAgentStartup', () => {
  it('queues the persisted default agent as an identity-only host launch', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex'
    })

    expect(startup).toEqual({
      command: '',
      launchAgent: 'codex',
      agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
      // agent_kind is host-authoritative (overwritten from the resolved receipt
      // before the emit), so the payload threads only surface fields.
      telemetry: {
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

  it.each([false, true])(
    'never assembles argv or session options, openAgentTabsInChatByDefault=%s',
    (openAgentTabsInChatByDefault) => {
      // The view mode (and with it any native-chat session options) is decided
      // by the activation path from the created worktree's own connection id —
      // not here, which is why this builder takes no readability argument.
      const startup = buildOnboardingFolderAgentStartup({
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex',
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault,
        nativeChatSessionOptions: {
          codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
          }
        }
      })

      expect(startup?.command).toBe('')
      expect(startup?.sessionOptions).toBeUndefined()
    }
  )

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

  it('builds the skipped-onboarding folder startup as an identity-only host launch', () => {
    // The command override no longer shapes the client output — the host resolves
    // the command from the current default; the request only carries identity.
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
      command: '',
      launchAgent: 'codex',
      agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
      // agent_kind is host-authoritative (overwritten from the resolved receipt
      // before the emit), so the payload threads only surface fields.
      telemetry: {
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })
})
