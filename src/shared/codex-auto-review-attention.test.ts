import { describe, expect, it } from 'vitest'
import {
  shouldSuppressCodexAutoReviewPermissionAttention,
  shouldSuppressCodexPermissionSyntheticTitle
} from './codex-auto-review-attention'

describe('Codex auto-review attention', () => {
  it('suppresses only confirmed auto-review permission attention', () => {
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'exec_command',
        reviewer: 'auto_review'
      })
    ).toBe(true)
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'request_user_input',
        reviewer: 'auto_review'
      })
    ).toBe(false)
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'exec_command',
        reviewer: 'user'
      })
    ).toBe(false)
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: undefined,
        toolName: 'exec_command',
        reviewer: 'auto_review'
      })
    ).toBe(false)
  })

  it('suppresses the synthetic permission title without hiding real questions', () => {
    expect(
      shouldSuppressCodexPermissionSyntheticTitle({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'exec_command',
        reviewer: 'auto_review',
        launchConfig: {
          agentArgs: `-c 'approvals_reviewer="auto_review"'`,
          agentEnv: {}
        }
      })
    ).toBe(true)
    expect(
      shouldSuppressCodexPermissionSyntheticTitle({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'request_user_input',
        reviewer: 'auto_review',
        launchConfig: {
          agentArgs: '--yolo',
          agentEnv: {}
        }
      })
    ).toBe(false)
  })
})
