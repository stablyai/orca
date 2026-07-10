import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'

function settingsWithGrokAccount() {
  return {
    ...getDefaultSettings('/tmp/orca-workspaces'),
    grokManagedAccounts: [
      {
        id: 'grok-1',
        email: 'grok@example.com',
        managedHomePath: '/managed/grok-home',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeGrokManagedAccountId: 'grok-1'
  }
}

describe('resolveTuiAgentLaunchEnv', () => {
  it('does not trust settings-sourced managed Grok homes in shared launch env resolution', () => {
    const env = resolveTuiAgentLaunchEnv('grok', {}, { settings: settingsWithGrokAccount() })

    expect(env).not.toHaveProperty('GROK_HOME')
  })

  it('preserves a user-authored GROK_HOME default for the main PTY boundary to resolve', () => {
    const env = resolveTuiAgentLaunchEnv(
      'grok',
      { grok: { GROK_HOME: '/manual/grok-home', OTHER: 'keep' } },
      { settings: settingsWithGrokAccount() }
    )

    expect(env).toMatchObject({
      GROK_HOME: '/manual/grok-home',
      OTHER: 'keep'
    })
  })

  it('does not inject a local managed Grok home into remote launches', () => {
    const env = resolveTuiAgentLaunchEnv(
      'grok',
      {},
      {
        settings: settingsWithGrokAccount(),
        isRemote: true
      }
    )

    expect(env).not.toHaveProperty('GROK_HOME')
  })

  it('does not inject a host managed Grok home into WSL launches', () => {
    const env = resolveTuiAgentLaunchEnv(
      'grok',
      {},
      {
        settings: settingsWithGrokAccount(),
        hostPlatform: 'win32',
        launchPlatform: 'linux'
      }
    )

    expect(env).not.toHaveProperty('GROK_HOME')
  })

  it('does not inject Grok account state into other agents', () => {
    const env = resolveTuiAgentLaunchEnv('codex', {}, { settings: settingsWithGrokAccount() })

    expect(env).not.toHaveProperty('GROK_HOME')
  })
})
