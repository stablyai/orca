import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'
import { extractAgentProviderSession } from '../../agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from '../../agent-launch/startup/agent-resume-argv'

const PANE_KEY = makePaneKey('loop-pane', '33333333-3333-4333-8333-333333333333')

describe('loop hooks', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function loop(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'loop', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('reports a turn as working, waiting on an approval, then done', () => {
    expect(loop({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the build' })).toMatchObject({
      state: 'working',
      agentType: 'loop',
      prompt: 'fix the build'
    })
    expect(
      loop({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'bun test' }
      })
    ).toMatchObject({ state: 'working', agentType: 'loop', toolName: 'Bash' })
    expect(loop({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toMatchObject({
      state: 'waiting',
      agentType: 'loop'
    })
    expect(
      loop({ hook_event_name: 'Stop', last_assistant_message: 'Build is green.' })
    ).toMatchObject({ state: 'done', agentType: 'loop', lastAssistantMessage: 'Build is green.' })
  })

  it('resumes the hook session with loop --session', () => {
    const session = extractAgentProviderSession('loop', {
      hook_event_name: 'Stop',
      session_id: 'a3f1c9e2'
    })
    expect(session).toEqual({ key: 'session_id', id: 'a3f1c9e2' })
    expect(getAgentResumeArgv('loop', session!)).toEqual(['loop', '--session', 'a3f1c9e2'])
  })
})
