import { describe, expect, it } from 'vitest'
import { agentPermissionArgsForLaunch } from './agent-permission-args'
import { liftAgentPermissionArgs } from './tui-agent-permission-lift'
import { resolveTuiAgentPermissionMode } from './tui-agent-permissions'

describe('Mistral Vibe Auto permission (--approval-policy smart-approve)', () => {
  it('injects, lifts, and resolves smart-approve as auto while --agent auto-approve stays full access', () => {
    expect(agentPermissionArgsForLaunch('mistral-vibe', 'auto', '--model mistral-large-4')).toBe(
      '--approval-policy smart-approve'
    )
    expect(
      agentPermissionArgsForLaunch('mistral-vibe', 'auto', '--approval-policy accept-edits')
    ).toBeNull()
    expect(
      liftAgentPermissionArgs('mistral-vibe', '--approval-policy smart-approve --model x')
    ).toEqual({ choice: 'auto', args: '--model x' })
    expect(liftAgentPermissionArgs('mistral-vibe', '--agent auto-approve')).toEqual({
      choice: 'full-access',
      args: ''
    })
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'mistral-vibe',
        agentArgs: '--approval-policy smart-approve'
      })
    ).toBe('auto')
    expect(
      resolveTuiAgentPermissionMode({ agent: 'mistral-vibe', agentArgs: '--agent auto-approve' })
    ).toBe('yolo')
  })
})
