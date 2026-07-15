import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  activeNativeChatToolMessageId,
  buildNativeChatTurnActivity
} from './native-chat-turn-activity'

function call(
  name: string,
  callId?: string,
  status?: 'in-progress' | 'completed' | 'incomplete'
): NativeChatBlock {
  return {
    type: 'tool-call',
    name,
    input: {},
    ...(callId ? { callId } : {}),
    ...(status ? { status } : {})
  }
}

function result(
  output: string,
  callId?: string,
  isError = false,
  outcome?: 'success' | 'error' | 'unknown'
): NativeChatBlock {
  return {
    type: 'tool-result',
    output,
    isError,
    ...(callId ? { callId } : {}),
    ...(outcome ? { outcome } : {})
  }
}

describe('buildNativeChatTurnActivity', () => {
  it('returns null when a block run has no tool activity', () => {
    expect(buildNativeChatTurnActivity([{ type: 'text', text: 'Done.' }], false)).toBeNull()
  })

  it('preserves ordered paired steps and reports completed activity', () => {
    const activity = buildNativeChatTurnActivity(
      [
        call('Read', 'read'),
        call('Edit', 'edit'),
        result('edited', 'edit'),
        result('read', 'read')
      ],
      false
    )

    expect(activity?.status).toBe('completed')
    expect(activity?.steps.map((item) => item.step.call?.name)).toEqual(['Read', 'Edit'])
    expect(activity?.steps.map((item) => item.step.result?.output)).toEqual(['read', 'edited'])
    expect(activity?.summaryStep.step.call?.name).toBe('Edit')
  })

  it('keeps the latest unfinished operation visible while working', () => {
    const activity = buildNativeChatTurnActivity(
      [call('Read'), result('contents'), call('Bash')],
      true
    )

    expect(activity?.status).toBe('running')
    expect(activity?.summaryStep.step.call?.name).toBe('Bash')
    expect(activity?.summaryStep.status).toBe('running')
    expect(activity?.steps.at(-1)?.status).toBe('running')
  })

  it('uses the latest settled operation while the provider continues working', () => {
    const activity = buildNativeChatTurnActivity([call('Bash'), result('passed')], true)

    expect(activity?.status).toBe('running')
    expect(activity?.summaryStep.step.call?.name).toBe('Bash')
  })

  it('surfaces a failed operation ahead of later successful work', () => {
    const activity = buildNativeChatTurnActivity(
      [call('Edit'), result('denied', undefined, true), call('Read'), result('contents')],
      false
    )

    expect(activity?.status).toBe('failed')
    expect(activity?.summaryStep.step.call?.name).toBe('Edit')
    expect(activity?.summaryStep.status).toBe('failed')
  })

  it('keeps a failed operation visible while later work is running', () => {
    const activity = buildNativeChatTurnActivity(
      [call('Edit'), result('denied', undefined, false, 'error'), call('Read')],
      true
    )

    expect(activity?.status).toBe('failed')
    expect(activity?.summaryStep.step.call?.name).toBe('Edit')
    expect(activity?.summaryStep.status).toBe('failed')
    expect(activity?.steps.at(-1)?.status).toBe('running')
  })

  it('honors provider-reported completed calls without a separate result', () => {
    const activity = buildNativeChatTurnActivity([call('shell', 'shell-1', 'completed')], false)

    expect(activity?.status).toBe('completed')
    expect(activity?.steps[0]?.status).toBe('completed')
  })

  it('honors provider-reported in-progress calls without global working state', () => {
    const activity = buildNativeChatTurnActivity([call('shell', 'shell-1', 'in-progress')], false)

    expect(activity?.status).toBe('running')
    expect(activity?.summaryStep.status).toBe('running')
  })

  it('does not claim an unmatched stopped call failed', () => {
    const activity = buildNativeChatTurnActivity([call('Bash')], false)

    expect(activity?.status).toBe('incomplete')
    expect(activity?.steps[0]?.status).toBe('incomplete')
  })

  it('preserves an unmatched result as a result-only lifecycle row', () => {
    const activity = buildNativeChatTurnActivity(
      [call('Read', 'call-a'), result('unmatched', 'call-b')],
      false
    )

    expect(activity?.steps).toHaveLength(2)
    expect(activity?.steps[1]?.step).toMatchObject({
      call: null,
      result: { output: 'unmatched' }
    })
  })
})

describe('activeNativeChatToolMessageId', () => {
  function message(
    id: string,
    role: NativeChatMessage['role'],
    blocks: NativeChatBlock[]
  ): NativeChatMessage {
    return { id, role, blocks, timestamp: 0, source: 'transcript' }
  }

  it('does not revive prior-turn activity after a new user prompt', () => {
    const messages = [
      message('old-user', 'user', [{ type: 'text', text: 'First' }]),
      message('old-tools', 'assistant', [call('Read'), result('done')]),
      message('new-user', 'user', [{ type: 'text', text: 'Second' }])
    ]

    expect(activeNativeChatToolMessageId(messages, true)).toBeNull()
  })

  it('selects the latest tool-bearing message in the active user turn', () => {
    const messages = [
      message('user', 'user', [{ type: 'text', text: 'Go' }]),
      message('first-tools', 'assistant', [call('Read'), result('done')]),
      message('latest-tools', 'assistant', [call('Bash')])
    ]

    expect(activeNativeChatToolMessageId(messages, true)).toBe('latest-tools')
    expect(activeNativeChatToolMessageId(messages, false)).toBeNull()
  })
})
