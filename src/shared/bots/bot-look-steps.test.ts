import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat/native-chat-types'
import { lookSteps } from './bot-look-steps'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'

function message(blocks: NativeChatBlock[]): NativeChatMessage {
  return { id: 'm1', role: 'assistant', blocks, timestamp: null, source: 'transcript' }
}

function bash(callId: string, command: string, state?: 'running' | 'completed' | 'failed') {
  return {
    type: 'tool-call' as const,
    name: 'Bash',
    callId,
    input: { command },
    ...(state ? { state } : {})
  }
}

describe('a look’s steps', () => {
  it('names connector reads by place, with the place’s source', () => {
    const steps = lookSteps([
      message([
        bash('1', `${CLI} connector read '#eng' --limit 30`, 'completed'),
        bash('2', `${CLI} connector read --limit 5 slack:T1:C2:1700.1`, 'completed'),
        bash('3', `${CLI} connector check ENG-9142`, 'failed'),
        bash('4', `${CLI} connector read acme/widgets#248`, 'running'),
        bash('5', `${CLI} connector find relay`),
        bash('6', 'orca connector capabilities --json', 'completed')
      ])
    ])
    expect(steps).toEqual([
      { position: 0, kind: 'read', target: '#eng', source: 'slack', state: 'done' },
      { position: 1, kind: 'read', target: '', source: 'slack', thread: true, state: 'done' },
      { position: 2, kind: 'check', target: 'ENG-9142', source: 'linear', state: 'failed' },
      { position: 3, kind: 'read', target: 'widgets#248', source: 'github', state: 'running' },
      { position: 4, kind: 'find', target: 'relay', state: 'running' },
      { position: 5, kind: 'connections', target: '', state: 'done' }
    ])
  })

  it('keeps any other call as the chat names it, marking gh as GitHub, done once its result lands', () => {
    const steps = lookSteps([
      message([bash('1', 'gh pr view 248'), bash('2', 'git log -5')]),
      message([{ type: 'tool-result', callId: '1', output: 'ok', isError: false }])
    ])
    expect(steps.map((step) => [step.kind, step.source, step.state])).toEqual([
      ['tool', 'github', 'done'],
      ['tool', undefined, 'running']
    ])
  })
})
