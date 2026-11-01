import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat-types'
import { nativeChatSubagentActivities } from './native-chat-activity'
import {
  nativeChatToolSubagentActivities,
  readNativeChatSubagentActivities
} from './native-chat-tool-subagents'

const DATE_ID = '01a19592-ddf5-7331-86a7-54ee1518c70f'
const TIP_ID = '01a19592-ddf5-7331-86a7-54ff437ddbbe'
const TOPICS_ID = '01a19592-ddf5-7331-86a7-550711a1ab6b'
const DATE_PROSE = 'The current date and time is Sat Oct 31 22:26:35 PDT 2026.'

function message(
  id: string,
  blocks: NativeChatBlock[],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks, ...extra }
}

function ack(id: string, description: string): string {
  return `Subagent started in background.\nsubagent_id: ${id}\ndescription: ${description}`
}

function spawnTurn(): NativeChatMessage[] {
  return [
    message('spawn', [
      {
        type: 'tool-call',
        name: 'spawn_subagent',
        callId: 'call-105',
        input: { description: "Report today's date", prompt: 'date', background: true }
      },
      {
        type: 'tool-call',
        name: 'spawn_subagent',
        callId: 'call-106',
        input: { description: 'Check main branch tip', prompt: 'tip', background: true }
      },
      {
        type: 'tool-call',
        name: 'spawn_subagent',
        callId: 'call-107',
        input: { description: 'Count workspace topics', prompt: 'topics', background: true }
      }
    ]),
    message('ack-date', [{ type: 'tool-result', output: ack(DATE_ID, "Report today's date") }], {
      role: 'tool'
    }),
    message('ack-tip', [{ type: 'tool-result', output: ack(TIP_ID, 'Check main branch tip') }], {
      role: 'tool'
    }),
    message(
      'ack-topics',
      [{ type: 'tool-result', output: ack(TOPICS_ID, 'Count workspace topics') }],
      { role: 'tool' }
    )
  ]
}

function completion(id: string, description: string, prose: string): string {
  return [
    '=== Multi-wait (wait_all) ===',
    `--- Task shell-9 [completed] ---`,
    'Command: WT=/tmp echo hi',
    'printed',
    `--- Task ${id} [completed] ---`,
    `Command: [subagent:general-purpose] ${description}`,
    'Duration: 1s',
    'Exit Code: 0',
    prose,
    '<subagent_meta>hidden</subagent_meta>',
    '<subagent_result>hidden</subagent_result>'
  ].join('\n')
}

describe('nativeChatToolSubagentActivities', () => {
  it('names each background spawn from its ack', () => {
    expect(nativeChatToolSubagentActivities(spawnTurn())).toEqual([
      { id: DATE_ID, label: "Report today's date", state: 'working', activity: 'date' },
      { id: TIP_ID, label: 'Check main branch tip', state: 'working', activity: 'tip' },
      { id: TOPICS_ID, label: 'Count workspace topics', state: 'working', activity: 'topics' }
    ])
  })

  it('settles a spawned child from a later subagent command and ignores the shell section', () => {
    const waited = message('wait', [
      { type: 'tool-call', name: 'get_command_or_subagent_output', input: {} },
      {
        type: 'tool-result',
        output: completion(DATE_ID, "Report today's date", DATE_PROSE)
      }
    ])
    expect(nativeChatToolSubagentActivities([...spawnTurn(), waited])).toEqual([
      { id: DATE_ID, label: "Report today's date", state: 'completed', activity: DATE_PROSE },
      { id: TIP_ID, label: 'Check main branch tip', state: 'working', activity: 'tip' },
      { id: TOPICS_ID, label: 'Count workspace topics', state: 'working', activity: 'topics' }
    ])
  })

  it('keeps a shell task off the roster', () => {
    const shell = message('shell', [
      { type: 'tool-call', name: 'run_terminal_command', input: {} },
      {
        type: 'tool-result',
        output: '--- Task shell-9 [completed] ---\nCommand: WT=/tmp echo hi\nprinted'
      }
    ])
    expect(nativeChatToolSubagentActivities([shell])).toEqual([])
  })

  it('marks a failed spawn failed', () => {
    const failed = message('bad', [
      {
        type: 'tool-call',
        name: 'SpawnSubagent',
        state: 'failed',
        input: { description: 'Broken launch' }
      },
      { type: 'tool-result', output: 'spawn failed', isError: true }
    ])
    expect(nativeChatToolSubagentActivities([failed])).toEqual([
      { id: 'spawn:bad:0', label: 'Broken launch', state: 'failed', activity: null }
    ])
  })

  it('creates a child from a completion that outlived the spawn call', () => {
    const waited = message('wait', [
      { type: 'tool-call', name: 'get_command_or_subagent_output', input: {} },
      { type: 'tool-result', output: completion(DATE_ID, "Report today's date", DATE_PROSE) }
    ])
    expect(nativeChatToolSubagentActivities([waited])).toEqual([
      { id: DATE_ID, label: "Report today's date", state: 'completed', activity: DATE_PROSE }
    ])
  })
})

describe('nativeChatSubagentActivities tool merge', () => {
  it('does not walk a settled seed back to the spawn ack', () => {
    const activities = nativeChatSubagentActivities(spawnTurn(), new Map(), [
      { id: DATE_ID, label: "Report today's date", state: 'completed', activity: DATE_PROSE }
    ])
    expect(activities[0]).toEqual({
      id: DATE_ID,
      label: "Report today's date",
      state: 'completed',
      activity: DATE_PROSE
    })
  })

  it('lets a named block replace the tool row without duplicating it', () => {
    const roster = message('roster', [
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [{ id: DATE_ID, label: 'Explore', state: 'completed' }]
      }
    ])
    expect(nativeChatSubagentActivities([...spawnTurn(), roster])).toEqual([
      { id: DATE_ID, label: 'Explore', state: 'completed', activity: 'date' },
      { id: TIP_ID, label: 'Check main branch tip', state: 'working', activity: 'tip' },
      { id: TOPICS_ID, label: 'Count workspace topics', state: 'working', activity: 'topics' }
    ])
  })
})

describe('Codex and Claude spawn tools', () => {
  it('keeps one Codex child when spawn_agent settles', () => {
    const activities = nativeChatSubagentActivities([
      message('spawn', [
        {
          type: 'tool-call',
          name: 'spawn_agent',
          callId: 'call_greeting',
          input: JSON.stringify({ task_name: 'sample_greeting', message: 'sealed' })
        }
      ]),
      message(
        'out',
        [
          {
            type: 'tool-result',
            callId: 'call_greeting',
            output: '{"task_name":"/root/sample_greeting"}'
          }
        ],
        { role: 'tool' }
      ),
      message('done', [
        {
          type: 'subagent',
          id: '/root/sample_greeting',
          label: 'sample_greeting',
          state: 'completed',
          groupId: 'turn-1'
        }
      ])
    ])
    expect(activities).toEqual([
      {
        id: '/root/sample_greeting',
        label: 'sample_greeting',
        state: 'completed',
        activity: 'sealed'
      }
    ])
  })

  it('leaves a sealed Codex spawn message off the sheet', () => {
    const activities = nativeChatToolSubagentActivities([
      message('spawn', [
        {
          type: 'tool-call',
          name: 'spawn_agent',
          callId: 'call_sealed',
          input: JSON.stringify({
            task_name: '/root/sample_greeting',
            message: `gAAAA${'x'.repeat(40)}`
          })
        }
      ])
    ])
    expect(activities).toEqual([
      {
        id: 'call_sealed',
        label: 'sample_greeting',
        state: 'working',
        activity: null
      }
    ])
  })

  it('reads a Claude Agent id and lets the notification settle it', () => {
    const activities = nativeChatSubagentActivities([
      message('call', [
        {
          type: 'tool-call',
          name: 'Agent',
          callId: 'toolu_1',
          input: {
            description: 'Debug mobile Recent sort',
            prompt: 'look',
            subagent_type: 'debugger',
            run_in_background: true
          }
        }
      ]),
      message(
        'result',
        [
          {
            type: 'tool-result',
            callId: 'toolu_1',
            output:
              'Async agent launched successfully.\nagentId: a361b8987c2d7be85 (internal ID - do not mention to user.)'
          }
        ],
        { role: 'tool' }
      ),
      message('note', [
        {
          type: 'subagent',
          id: 'a361b8987c2d7be85',
          label: 'Debug mobile Recent sort',
          state: 'completed',
          groupId: 'claude',
          activity: 'Fixed and pushed.'
        }
      ])
    ])
    expect(activities).toEqual([
      {
        id: 'a361b8987c2d7be85',
        label: 'Debug mobile Recent sort',
        state: 'completed',
        activity: 'Fixed and pushed.'
      }
    ])
  })

  it('settles a synchronous Claude Agent on the tool result agent id', () => {
    const activities = nativeChatToolSubagentActivities([
      message('call', [
        {
          type: 'tool-call',
          name: 'Agent',
          callId: 'toolu_agent',
          input: { description: 'Fix CodeRabbit', prompt: 'review the diff' }
        }
      ]),
      message(
        'result',
        [
          {
            type: 'tool-result',
            callId: 'toolu_agent',
            output: 'Fixed the review threads.',
            subagent: { id: 'agent-1', state: 'completed' }
          }
        ],
        { role: 'tool' }
      )
    ])
    expect(activities).toEqual([
      {
        id: 'agent-1',
        label: 'Fix CodeRabbit',
        state: 'completed',
        activity: 'Fixed the review threads.'
      }
    ])
  })
})

describe('readNativeChatSubagentActivities', () => {
  it('drops a seed that is not a roster', () => {
    expect(
      readNativeChatSubagentActivities([
        { id: DATE_ID, label: "Report today's date", state: 'working', activity: null }
      ])
    ).toEqual([{ id: DATE_ID, label: "Report today's date", state: 'working', activity: null }])
    expect(readNativeChatSubagentActivities([])).toBeNull()
    expect(readNativeChatSubagentActivities(null)).toBeNull()
    expect(
      readNativeChatSubagentActivities([
        { id: DATE_ID, label: "Report today's date", state: 'spinning', activity: null }
      ])
    ).toBeNull()
  })
})
