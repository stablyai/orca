import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AgentLaunchProfilesSection } from './AgentLaunchProfilesSection'
import {
  buildAgentLaunchProfileFromDraft,
  createAgentLaunchProfileId,
  deleteAgentLaunchProfile,
  parseAgentLaunchProfileEnv,
  upsertAgentLaunchProfile
} from './agent-launch-profile-draft'

describe('AgentLaunchProfilesSection helpers', () => {
  it('builds normalized profile data from form drafts', () => {
    const profile = buildAgentLaunchProfileFromDraft({
      id: 'codex:work',
      draft: {
        agentId: 'codex',
        name: ' Work ',
        commandOverride: ' codex-nightly ',
        args: ' --profile work ',
        envText: ' CODEX_LOG=info \nEMPTY=\nBAD'
      }
    })

    expect(profile).toEqual({
      id: 'codex:work',
      agentId: 'codex',
      name: 'Work',
      commandOverride: 'codex-nightly',
      args: '--profile work',
      env: { CODEX_LOG: 'info', EMPTY: '', BAD: '' }
    })
  })

  it('creates stable profile ids and resolves collisions', () => {
    expect(
      createAgentLaunchProfileId({
        agentId: 'codex',
        name: 'Work Laptop',
        profiles: []
      })
    ).toBe('codex:work-laptop')

    expect(
      createAgentLaunchProfileId({
        agentId: 'codex',
        name: 'Work Laptop',
        profiles: [{ id: 'codex:work-laptop', agentId: 'codex', name: 'Work Laptop' }]
      })
    ).toBe('codex:work-laptop-2')
  })

  it('upserts and deletes profiles through the same normalization path as settings', () => {
    const created = upsertAgentLaunchProfile([], {
      id: 'codex:work',
      agentId: 'codex',
      name: ' Work ',
      args: ' --profile work '
    })
    const updated = upsertAgentLaunchProfile(created, {
      id: 'codex:work',
      agentId: 'codex',
      name: 'Work',
      args: '--profile work --model gpt-5'
    })

    expect(updated).toEqual([
      {
        id: 'codex:work',
        agentId: 'codex',
        name: 'Work',
        args: '--profile work --model gpt-5'
      }
    ])
    expect(deleteAgentLaunchProfile(updated, 'codex:work')).toEqual([])
  })

  it('parses environment lines into key/value pairs', () => {
    expect(parseAgentLaunchProfileEnv('A=1\nB=two=parts\n\n C = spaced ')).toEqual({
      A: '1',
      B: 'two=parts',
      C: ' spaced'
    })
  })
})

describe('AgentLaunchProfilesSection', () => {
  it('renders existing named profiles under the built-in agent label', () => {
    const markup = renderToStaticMarkup(
      <AgentLaunchProfilesSection
        settings={{
          ...getDefaultSettings(join(tmpdir(), 'orca-agent-launch-profiles-test')),
          agentLaunchProfiles: [
            {
              id: 'codex:work',
              agentId: 'codex',
              name: 'Work',
              args: '--profile work'
            }
          ]
        }}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('Launch Profiles')
    expect(markup).toContain('Codex: Work')
    expect(markup).toContain('--profile work')
  })
})
