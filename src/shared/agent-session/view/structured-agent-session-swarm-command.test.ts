import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionHostCommand
} from './structured-agent-session-composer'
import { structuredSessionSlashCommands } from './structured-agent-session-slash-menu'

describe('Antigravity /swarm & /swarm board command handling', () => {
  it('surfaces /swarm with preview/quota hint and <task | board> only when reported by the session', () => {
    const reportedDescription =
      '(Preview & Quota Heavy) Run a swarm: several agents working in parallel on one task.'
    const withSwarm = structuredSessionSlashCommands(
      'antigravity',
      ['clear'],
      [
        { name: 'alpha-skill', kind: 'command', description: 'Skill A' },
        { name: 'swarm', kind: 'command', description: reportedDescription }
      ]
    )
    expect(withSwarm.find((entry) => entry.name === 'swarm')).toMatchObject({
      name: 'swarm',
      description: reportedDescription,
      argumentHint: '<task | board>'
    })

    const withoutHint = structuredSessionSlashCommands(
      'antigravity',
      ['clear'],
      [{ name: 'swarm', kind: 'command' }]
    )
    expect(withoutHint.find((entry) => entry.name === 'swarm')).toMatchObject({
      name: 'swarm',
      description: '(Preview & Quota Heavy) Run a swarm',
      argumentHint: '<task | board>'
    })

    // Legacy runtimes that do not report `swarm` must not expose `/swarm`.
    const legacy = structuredSessionSlashCommands(
      'antigravity',
      ['clear'],
      [{ name: 'alpha-skill', kind: 'command', description: 'Skill A' }]
    )
    expect(legacy.some((entry) => entry.name === 'swarm')).toBe(false)
  })

  it('intercepts /swarm board locally when supported, while forwarding /swarm <task>', async () => {
    expect(
      isStructuredAgentSessionHostCommand('/swarm board', false, 'antigravity', [], false, true)
    ).toBe(true)
    expect(
      isStructuredAgentSessionHostCommand(
        '/swarm implement cache',
        false,
        'antigravity',
        [],
        false,
        true
      )
    ).toBe(false)
    expect(
      isStructuredAgentSessionHostCommand('/swarm board', false, 'antigravity', [], false, false)
    ).toBe(false)

    const openSwarmBoard = vi.fn()
    const outcome = await dispatchStructuredAgentSessionComposerCommand('/swarm board', {
      agent: 'antigravity',
      snapshot: [],
      invokeAction: async () => false,
      setOption: async () => false,
      openSwarmBoard
    })
    expect(outcome).toEqual({ handled: true, accepted: true, error: null })
    expect(openSwarmBoard).toHaveBeenCalledTimes(1)

    const passThrough = await dispatchStructuredAgentSessionComposerCommand('/swarm split tasks', {
      agent: 'antigravity',
      snapshot: [],
      invokeAction: async () => false,
      setOption: async () => false,
      openSwarmBoard
    })
    expect(passThrough).toEqual({ handled: false, accepted: false, error: null })
  })
})
