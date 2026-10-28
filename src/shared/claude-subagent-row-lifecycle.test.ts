/** Live regressions: Claude 2.1.210 named lanes accumulate idle rows; 2.1.217 teammates resume between turns; killed children omit stop hooks; 2.1.280 child API errors emit only StopFailure(agent_id). Drive normalizeHookPayload and actual sidebar snapshots. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('claude subagent sidebar row lifecycle', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const claudeEvent = (payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> =>
    normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')

  const spawnTeammate = (
    name: string,
    agentId: string,
    description: string,
    order: 'start-first' | 'spawn-result-first' = 'start-first'
  ): void => {
    const start = () =>
      claudeEvent({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: name })
    const spawnResult = () =>
      claudeEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description, prompt: `Reply ${name}`, name },
        tool_response: { status: 'teammate_spawned', agent_id: agentId, name }
      })
    if (order === 'start-first') {
      start()
      spawnResult()
    } else {
      spawnResult()
      start()
    }
  }

  it('drops each finished workflow subagent instead of accumulating idle rows', () => {
    claudeEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Help me research Vercel sandbox usage (ultracode)'
    })

    // Long workflow turns once accumulated idle rows for every finished one-shot.
    let last: ReturnType<typeof claudeEvent>
    for (let i = 0; i < 21; i++) {
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: `awf0000000000000${String(i).padStart(2, '0')}`,
        agent_type: 'general-purpose'
      })
      last = claudeEvent({
        hook_event_name: 'SubagentStop',
        agent_id: `awf0000000000000${String(i).padStart(2, '0')}`
      })
      expect(last?.payload.subagents).toBeUndefined()
    }

    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aworking0000000001',
      agent_type: 'general-purpose'
    })
    const working = claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aworking0000000002',
      agent_type: 'general-purpose'
    })
    expect(working?.payload.subagents).toHaveLength(2)
    expect(working?.payload.state).toBe('working')
  })

  it('removes a killed subagent whose SubagentStop was never delivered at the next lead Stop', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'research task' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'akilled0000000001',
      agent_type: 'general-purpose'
    })

    // Killed children emit no stop; the next complete inventory must reap them.
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        {
          id: 'aother00000000001',
          type: 'subagent',
          status: 'running',
          agent_type: 'general-purpose'
        }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aother00000000001', state: 'working' })
    ])
    expect(stop?.payload.state).toBe('working')

    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aother00000000001' })
    const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
    expect(finalStop?.payload.state).toBe('done')
    expect(finalStop?.payload.subagents).toBeUndefined()
  })

  it('reaps stopped never-idle-confirmed named lanes at the lead Stop, not on their own stop', () => {
    // Claude 2.1.210 named lanes use lifecycle a<name>-<hex> but unrelated permanently-running teammate task IDs; unconfirmed lanes once accumulated idle rows.
    claudeEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: '--- Orchestration Messages (1) --- (ultracode)'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aweb-research-8a76b7d7595ce04e',
      agent_type: 'web-research'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aoss-hunt-95a28c160dc99e5e',
      agent_type: 'oss-hunt'
    })

    const teammateTasks = [
      { id: 'tws2g167l', type: 'teammate', status: 'running', description: 'web research' },
      { id: 't6s2brfv7', type: 'teammate', status: 'running', description: 'oss hunt' }
    ]
    const midStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(midStop?.payload.state).toBe('working')
    expect(midStop?.payload.subagents).toHaveLength(2)

    // SubagentStop may end only a turn, so park the row until inventory/TeammateIdle proves its lifecycle.
    const afterFirst = claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'aweb-research-8a76b7d7595ce04e',
      background_tasks: teammateTasks
    })
    expect(afterFirst?.payload.subagents).toHaveLength(2)
    expect(afterFirst?.payload.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'aoss-hunt-95a28c160dc99e5e', state: 'working' }),
        expect.objectContaining({ id: 'aweb-research-8a76b7d7595ce04e', state: 'idle' })
      ])
    )

    // Without TeammateIdle proof, complete inventory reaps both idle lanes despite permanently-running teammate task rows.
    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aoss-hunt-95a28c160dc99e5e' })
    const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(finalStop?.payload.state).toBe('done')
    expect(finalStop?.payload.subagents).toBeUndefined()
  })

  it('parks a TeammateIdle-confirmed teammate as a persistent idle row without gating done', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestration (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'areview-standards-2750dacd',
      agent_type: 'review-standards'
    })

    // Claude 2.1.217 TeammateIdle confirms a resumable child, preserving visibility between working bursts.
    const idled = claudeEvent({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'review-standards',
      team_name: 'orchestration'
    })
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areview-standards-2750dacd', state: 'idle' })
    ])

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'tstd', type: 'teammate', status: 'running' }]
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areview-standards-2750dacd', state: 'idle' })
    ])

    const teardown = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
    expect(teardown?.payload.state).toBe('done')
    expect(teardown?.payload.subagents).toBeUndefined()
  })

  it('keeps a turn-based teammate visible across its work/idle cycle and revives it on resume', () => {
    // Claude 2.1.217 capture: SendMessage resumes the same named teammate across work/idle turns.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'map the polling pipeline' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      agent_type: 'poll-map'
    })
    const teammateTasks = [{ id: 'ta5jpcars', type: 'teammate', status: 'running' }]

    // Captured order: SubagentStop precedes TeammateIdle.
    claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      background_tasks: teammateTasks
    })
    const idled = claudeEvent({ hook_event_name: 'TeammateIdle', teammate_name: 'poll-map' })
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'idle' })
    ])

    const leadStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'idle' })
    ])

    const revived = claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      agent_type: 'poll-map'
    })
    expect(revived?.payload.state).toBe('working')
    expect(revived?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'working' })
    ])
  })

  it('reaps a killed named agent at the lead Stop when no teammate task remains', () => {
    // Named lifecycle IDs never match task IDs; only complete absence of teammate tasks proves their lost finish.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestration (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'acr-triage-1-c5a0588e7a2e4151',
      agent_type: 'cr-triage-1'
    })

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        {
          id: 'awf0000000000000zz',
          type: 'subagent',
          status: 'running',
          agent_type: 'general-purpose'
        }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'awf0000000000000zz', state: 'working' })
    ])
  })

  it('removes aborted subagents on the interrupt Stop so the pane can resolve', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'long batch' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aaborted000000001',
      agent_type: 'general-purpose'
    })

    // Captured Esc/Ctrl+C emits child SubagentStop then interrupted lead Stop; both clean the roster.
    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aaborted000000001' })
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: []
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.interrupted).toBe(true)
    expect(stop?.payload.subagents).toBeUndefined()
  })

  // Captured on claude 2.1.280 against an API that answered the child with a 429.
  const rateLimitedStopFailure = (agentId: string, agentType: string): Record<string, unknown> => ({
    hook_event_name: 'StopFailure',
    agent_id: agentId,
    agent_type: agentType,
    error: 'rate_limit',
    last_assistant_message: 'API Error: Request rejected (429) · usage limit'
  })

  it('parks a rate-limited teammate idle so the finished lead reads done', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'spawn the helper' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'ahelper-5f4e189c7003c291',
      agent_type: 'helper'
    })
    const teammateTasks = [
      { id: 'ttfehv0wp', type: 'teammate', status: 'running', description: 'helper task' }
    ]
    const leadStop = claudeEvent({
      hook_event_name: 'Stop',
      last_assistant_message: 'Helper is on it.',
      background_tasks: teammateTasks
    })
    expect(leadStop?.payload.state).toBe('working')

    const failed = claudeEvent(rateLimitedStopFailure('ahelper-5f4e189c7003c291', 'helper'))
    expect(failed?.payload.state).toBe('done')
    expect(failed?.payload.mainAgent?.state).toBe('done')
    expect(failed?.payload.lastAssistantMessage).toBe('Helper is on it.')
    expect(failed?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'ahelper-5f4e189c7003c291', state: 'idle' })
    ])

    // Claude keeps listing the failed teammate as running; that must not revive it.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    const nextStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(nextStop?.payload.state).toBe('done')
  })

  it('settles done when a teammate is rate-limited before the lead stops (captured order)', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'spawn the helper' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'ahelper-27f64cea4c5b8ded',
      agent_type: 'helper'
    })
    claudeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_sleep1' })

    const failed = claudeEvent(rateLimitedStopFailure('ahelper-27f64cea4c5b8ded', 'helper'))
    expect(failed?.payload.state).toBe('working')
    expect(failed?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'ahelper-27f64cea4c5b8ded', state: 'idle' })
    ])

    claudeEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_sleep1' })
    const leadStop = claudeEvent({
      hook_event_name: 'Stop',
      last_assistant_message: 'LEAD_DONE',
      background_tasks: [
        { id: 'txq288jxw', type: 'teammate', status: 'running', description: 'helper task' }
      ]
    })
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.lastAssistantMessage).toBe('LEAD_DONE')
  })

  it('removes a rate-limited one-shot background child that outlived the lead turn', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'research in background' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'a6324370b7bede0c7',
      agent_type: 'general-purpose'
    })
    const leadStop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a6324370b7bede0c7', type: 'subagent', status: 'running' }]
    })
    expect(leadStop?.payload.state).toBe('working')

    const failed = claudeEvent(rateLimitedStopFailure('a6324370b7bede0c7', 'general-purpose'))
    expect(failed?.payload.state).toBe('done')
    expect(failed?.payload.subagents).toBeUndefined()
  })

  it('keeps the pane working when one of two children is rate-limited', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'two helpers' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'afirst-1a2b3c4d',
      agent_type: 'first'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'asecond-5e6f7a8b',
      agent_type: 'second'
    })

    const failed = claudeEvent(rateLimitedStopFailure('afirst-1a2b3c4d', 'first'))
    expect(failed?.payload.state).toBe('working')
    expect(failed?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'afirst-1a2b3c4d', state: 'idle' }),
      expect.objectContaining({ id: 'asecond-5e6f7a8b', state: 'working' })
    ])
  })

  it('drops teammates stopped with TaskStop while another teammate stays alive', () => {
    // Shapes captured live on 2.1.308: TaskStop fires no lifecycle hook, and each teammate's
    // background_tasks entry carries its spawn description under an unrelated `t…` id.
    const alphaTask = { id: 'tjv37r4y4', type: 'teammate', status: 'running', description: 'Alpha' }
    const betaTask = { id: 'tjint303j', type: 'teammate', status: 'running', description: 'Beta' }
    const gammaTask = { id: 'te1pn74jo', type: 'teammate', status: 'running', description: 'Gamma' }
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'start alpha, beta and gamma' })
    spawnTeammate('alpha', 'aalpha-b1567bb51740a755', 'Alpha')
    // Hook requests are handled unordered, so the spawn result can land before SubagentStart.
    spawnTeammate('beta', 'abeta-1917b198710ec27a', 'Beta', 'spawn-result-first')
    spawnTeammate('gamma', 'agamma-8889833b0c898959', 'Gamma')
    for (const [name, agentId] of [
      ['alpha', 'aalpha-b1567bb51740a755'],
      ['gamma', 'agamma-8889833b0c898959']
    ]) {
      claudeEvent({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: name })
      claudeEvent({ hook_event_name: 'TeammateIdle', agent_id: agentId, teammate_name: name })
    }
    const listed = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [alphaTask, betaTask, gammaTask]
    })
    expect(listed?.payload.state).toBe('working')
    expect(listed?.payload.subagents).toHaveLength(3)

    // The lead stops idle alpha and still-working beta; only gamma's entry is listed after.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'stop alpha and beta' })
    const afterStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [gammaTask] })
    expect(afterStop?.payload.state).toBe('done')
    expect(afterStop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'agamma-8889833b0c898959', state: 'idle' })
    ])
  })

  it.each([
    {
      kind: 'clipped',
      spawned: `Review ${'x'.repeat(1100)}`,
      listed: `Review ${'x'.repeat(993)}… [+107 chars]`
    },
    { kind: 'whitespace-collapsed', spawned: ' Review\n  the   diff ', listed: 'Review the diff' }
  ])(
    'keeps a working teammate whose inventory description was $kind while reaping a stopped sibling',
    ({ spawned, listed }) => {
      spawnTeammate('alpha', 'aalpha-b1567bb51740a755', 'Alpha')
      spawnTeammate('beta', 'abeta-1917b198710ec27a', spawned)

      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'tbeta', type: 'teammate', status: 'running', description: listed }
        ]
      })
      expect(stop?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'abeta-1917b198710ec27a', state: 'working' })
      ])
      expect(stop?.payload.state).toBe('working')
    }
  )

  it('keeps every teammate when a listed teammate matches no recorded spawn description', () => {
    spawnTeammate('alpha', 'aalpha-b1567bb51740a755', 'Alpha')
    spawnTeammate('beta', 'abeta-1917b198710ec27a', 'Beta')

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'tbeta', type: 'teammate', status: 'running', description: 'Beta' },
        { id: 'tother', type: 'teammate', status: 'running', description: 'Beta, reworded' }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aalpha-b1567bb51740a755', state: 'working' }),
      expect.objectContaining({ id: 'abeta-1917b198710ec27a', state: 'working' })
    ])
  })

  it.each(['identical descriptions', 'clipped descriptions'])('keeps ambiguous %s', (kind) => {
    const prefix = 'Review '.repeat(150)
    const description = kind === 'identical descriptions' ? 'Review code' : prefix
    spawnTeammate('alpha', 'aalpha-b1567bb51740a755', description)
    spawnTeammate(
      'beta',
      'abeta-1917b198710ec27a',
      kind === 'identical descriptions' ? description : `${prefix} with tests`
    )
    const listed =
      kind === 'identical descriptions' ? description : `${prefix.slice(0, 1000)}… [+61 chars]`

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'tsurvivor', type: 'teammate', status: 'running', description: listed }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aalpha-b1567bb51740a755', state: 'working' }),
      expect.objectContaining({ id: 'abeta-1917b198710ec27a', state: 'working' })
    ])
    expect(stop?.payload.state).toBe('working')
  })

  it.each([
    { evidence: 'missing inventory', tasks: undefined },
    {
      evidence: 'undescribed teammate',
      tasks: [{ id: 'tother', type: 'teammate', status: 'running' }]
    },
    {
      evidence: 'partial inventory',
      tasks: [{ id: 'tother', type: 'teammate', status: 'running', description: 'Other' }, null]
    }
  ])('keeps a confirmed idle teammate with $evidence', ({ tasks }) => {
    spawnTeammate('alpha', 'aalpha-b1567bb51740a755', 'Alpha')
    claudeEvent({ hook_event_name: 'TeammateIdle', teammate_name: 'alpha' })

    const stop = claudeEvent({ hook_event_name: 'Stop', background_tasks: tasks })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aalpha-b1567bb51740a755', state: 'idle' })
    ])
  })
})
