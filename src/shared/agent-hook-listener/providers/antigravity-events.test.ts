import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAntigravityEvent } from './antigravity-events'

describe('normalizeAntigravityEvent subagent roster', () => {
  const event = (
    state: HookListenerState,
    name: string,
    payload: Record<string, unknown>,
    prompt = ''
  ) => normalizeAntigravityEvent(state, name, prompt, 'pane-agy:1', payload)

  it('tracks spawned subagents across child hooks while preserving parent prompt and lead status', () => {
    const state = createHookListenerState()

    expect(
      event(
        state,
        'PreInvocation',
        { conversationId: 'conv-parent', lastUserInput: 'Audit sidebar subagent rows' },
        'Audit sidebar subagent rows'
      )
    ).toMatchObject({
      state: 'working',
      agentType: 'antigravity',
      prompt: 'Audit sidebar subagent rows'
    })

    event(state, 'PreToolUse', {
      conversationId: 'conv-parent',
      toolCall: {
        name: 'invoke_subagent',
        args: {
          TypeName: 'research',
          Role: 'Sidebar Researcher',
          Prompt: 'Inspect sidebar subagent rendering',
          Model: 'inherit'
        }
      }
    })
    event(state, 'PostToolUse', {
      conversationId: 'conv-parent',
      toolCall: { name: 'invoke_subagent', args: {} }
    })

    const heldParent = event(state, 'Stop', {
      conversationId: 'conv-parent',
      fullyIdle: false
    })
    expect(heldParent).toMatchObject({
      state: 'working',
      prompt: 'Audit sidebar subagent rows',
      mainAgent: { state: 'done' }
    })

    const childWorking = event(state, 'PreInvocation', {
      conversationId: 'conv-child-1'
    })
    expect(childWorking).toMatchObject({
      state: 'working',
      prompt: 'Audit sidebar subagent rows',
      mainAgent: { state: 'done', stateStartedAt: heldParent?.mainAgent?.stateStartedAt },
      subagents: [
        {
          id: 'conv-child-1',
          agentType: 'research',
          description: 'Sidebar Researcher',
          state: 'working'
        }
      ]
    })
    expect(childWorking?.subagents?.[0]?.model).toBeUndefined()

    const childWaiting = event(state, 'PreToolUse', {
      conversationId: 'conv-child-1',
      toolCall: { name: 'ask_question', args: { questions: [] } }
    })
    expect(childWaiting).toMatchObject({
      state: 'waiting',
      subagents: [
        {
          id: 'conv-child-1',
          agentType: 'research',
          description: 'Sidebar Researcher',
          state: 'waiting'
        }
      ]
    })

    const childDone = event(state, 'Stop', {
      conversationId: 'conv-child-1',
      fullyIdle: true
    })
    expect(childDone?.state).toBe('working')
    expect(childDone?.subagents).toBeUndefined()

    // Resuming the same child via send_message retains its Role and TypeName identity.
    event(state, 'PreInvocation', { conversationId: 'conv-parent' })
    event(state, 'PreToolUse', {
      conversationId: 'conv-parent',
      toolCall: {
        name: 'send_message',
        args: { Recipient: 'conv-child-1', Message: 'Check mobile' }
      }
    })
    const resumedChild = event(state, 'PreInvocation', { conversationId: 'conv-child-1' })
    expect(resumedChild?.subagents).toMatchObject([
      {
        id: 'conv-child-1',
        agentType: 'research',
        description: 'Sidebar Researcher',
        state: 'working'
      }
    ])

    // Terminal parent Stop retires the roster completely.
    const terminalDone = event(state, 'Stop', {
      conversationId: 'conv-parent',
      fullyIdle: true,
      transcriptPath: '/tmp/parent.jsonl'
    })
    expect(terminalDone).toMatchObject({
      state: 'done'
    })
    expect(terminalDone?.subagents).toBeUndefined()
  })
})
