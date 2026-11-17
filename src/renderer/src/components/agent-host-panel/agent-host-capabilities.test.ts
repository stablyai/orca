import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  hostCapabilities,
  type AgentHostAvailability,
  type AgentHostKind
} from './agent-host-capabilities'
import { agentHostAvailability, agentHostKind } from './agent-host-kind'

const t: Translate = (_key, fallback, values) =>
  (fallback ?? '').replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

const KINDS: AgentHostKind[] = [
  'local',
  'sshClassic',
  'sshOrcad',
  'wsl',
  'recipe',
  'paired',
  'cloud'
]
const ctx = { host: 'devbox', date: 'Nov 9, 2026' }

describe('hostCapabilities', () => {
  it('covers all seven kinds with the same frame', () => {
    for (const kind of KINDS) {
      const caps = hostCapabilities(kind, 'available', ctx, t)
      expect(caps.agents.title).toBeTruthy()
      expect(caps.footer.at(-1)).toBe('allHosts')
      expect(caps.notice).toBeNull()
    }
  })

  it('keeps Source and Cloud secrets to Orca Cloud, and sign-out off Cloud and this computer', () => {
    const cloud = hostCapabilities('cloud', 'available', ctx, t)
    expect(cloud).toMatchObject({ source: true, cloudSecrets: true, signOut: false })
    expect(cloud.agents.title).toBe('Agents')
    expect(cloud.footer).toEqual(['agentAccounts', 'cloudSecrets', 'allHosts'])
    expect(hostCapabilities('local', 'available', ctx, t)).toMatchObject({
      source: false,
      cloudSecrets: false,
      signOut: false
    })
    for (const kind of ['sshClassic', 'sshOrcad', 'wsl', 'recipe', 'paired'] as const) {
      expect(hostCapabilities(kind, 'available', ctx, t)).toMatchObject({
        source: false,
        cloudSecrets: false,
        signOut: true
      })
    }
  })

  it('uses the spec copy for each kind', () => {
    expect(hostCapabilities('wsl', 'available', ctx, t).environmentHelp).toBe(
      'Agents get the distro’s own environment. Orca doesn’t add variables in WSL.'
    )
    expect(hostCapabilities('sshClassic', 'available', ctx, t).keys.help).toBe(
      'Sent over SSH when the agent starts. Not stored on devbox.'
    )
    expect(hostCapabilities('recipe', 'available', ctx, t).environmentHelp).toBeNull()
    expect(hostCapabilities('cloud', 'available', ctx, t).agents.help).toBe(
      'Agent sign-ins aren’t stored in the sandbox, so new, cloned and restarted sandboxes work the same.'
    )
  })

  it('states why actions are off while the host can’t answer, and never offers to start it', () => {
    const cases: [AgentHostKind, AgentHostAvailability, string][] = [
      ['sshClassic', 'disconnected', 'Open a workspace on devbox to sign in or out.'],
      ['wsl', 'stopped', 'devbox is stopped. Opening a workspace on it starts it as usual.'],
      ['recipe', 'suspended', 'devbox is suspended. Opening the workspace resumes it as usual.'],
      ['paired', 'unreachable', 'Can’t reach devbox. Sign-in and sign-out need it online.']
    ]
    for (const [kind, availability, reason] of cases) {
      const caps = hostCapabilities(kind, availability, ctx, t)
      expect(caps.actionsDisabledReason).toBe(reason)
      expect(caps.notice).toContain('Nov 9, 2026')
    }
    expect(hostCapabilities('wsl', 'stopped', { host: 'Ubuntu', date: null }, t).notice).toBe(
      'Ubuntu is stopped. Opening a workspace on it starts it as usual.'
    )
  })

  it('needs no notice for an asleep Cloud workspace; archived is read-only', () => {
    const asleep = hostCapabilities('cloud', 'asleep', ctx, t)
    expect(asleep.notice).toBeNull()
    expect(asleep.actionsDisabledReason).toBeNull()
    expect(hostCapabilities('cloud', 'archived', ctx, t).actionsDisabledReason).toBe(
      'This workspace is archived.'
    )
  })
})

describe('agentHostKind / agentHostAvailability', () => {
  it('classifies hosts from what the renderer holds', () => {
    expect(agentHostKind('local', null)).toBe('local')
    expect(agentHostKind('ssh', null)).toBe('sshClassic')
    expect(agentHostKind('runtime', { source: 'ephemeral-vm', name: 'Orca Cloud' })).toBe('recipe')
    expect(agentHostKind('runtime', { source: 'ephemeral-vm', name: 'web sandbox 0a1b2c3d' })).toBe(
      'cloud'
    )
    expect(agentHostKind('runtime', { name: 'mac-mini' })).toBe('paired')
  })

  it('maps health without ever implying a wake', () => {
    expect(
      agentHostAvailability('cloud', {
        health: 'suspended',
        cloud: { asleep: true, archived: false }
      })
    ).toBe('asleep')
    expect(agentHostAvailability('recipe', { health: 'suspended' })).toBe('suspended')
    expect(agentHostAvailability('sshOrcad', { health: 'disconnected' })).toBe('disconnected')
    expect(agentHostAvailability('wsl', { health: 'available', wslStopped: true })).toBe('stopped')
    expect(agentHostAvailability('paired', { health: 'error' })).toBe('unreachable')
  })
})
