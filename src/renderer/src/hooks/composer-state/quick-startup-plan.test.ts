import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { buildQuickComposerStartup } from './quick-startup-plan'

const settings = {
  agentLaunchProfiles: [
    { id: 'codex-work', agent: 'codex', label: 'Work', args: '-c model_provider="work"' }
  ]
} as unknown as GlobalSettings

function build(launchProfileId: string | null) {
  return buildQuickComposerStartup({
    agent: 'codex',
    launchProfileId,
    prompt: '',
    draftPrompt: null,
    settings,
    repoConnectionId: null,
    platform: 'linux',
    shell: null,
    isRemote: false,
    telemetrySource: 'sidebar'
  })
}

describe('buildQuickComposerStartup launch profiles', () => {
  it('layers the profile into the startup command and env the host receives', () => {
    const startup = build('codex-work')
    expect(startup.backendStartup?.command).toContain('model_provider')
    expect(startup.backendStartup?.env?.ORCA_AGENT_LAUNCH_PROFILE).toBe('codex-work')
  })

  it('stamps only the home marker for a built-in secondary home', () => {
    const env = build('codex-secondary-home').backendStartup?.env
    expect(env?.ORCA_CODEX_HOME_PROFILE).toBe('codex-secondary-home')
    expect(env?.CODEX_HOME).toBeUndefined()
  })

  it('keeps the default launch without a profile', () => {
    expect(build(null).backendStartup?.env?.ORCA_AGENT_LAUNCH_PROFILE).toBeUndefined()
  })
})
