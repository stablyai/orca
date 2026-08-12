import { describe, expect, it } from 'vitest'
import {
  shouldSuppressCodexAutoReviewPermissionAttention,
  shouldSuppressCodexPermissionSyntheticTitle
} from './codex-auto-review-attention'

describe('Codex auto-review attention', () => {
  it('suppresses only confirmed auto-review PermissionRequest attention', () => {
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
        state: 'blocked',
        hookEventName: 'PermissionRequest',
        toolName: 'Bash',
        reviewer: 'auto_review'
      })
    ).toBe(true)
  })

  it('fails open for user-owned or unknown reviewer', () => {
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
        hookEventName: 'PermissionRequest',
        toolName: 'exec_command',
        reviewer: 'unknown'
      })
    ).toBe(false)
  })

  it('suppresses auto-review waits when hook name is absent (Codex waiting ≈ permission)', () => {
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: undefined,
        toolName: 'exec_command',
        reviewer: 'auto_review'
      })
    ).toBe(true)
  })

  it('fails open for explicit non-permission hooks under auto-review', () => {
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'AfterToolUse',
        toolName: 'exec_command',
        reviewer: 'auto_review'
      })
    ).toBe(false)
  })

  it('never suppresses genuine request_user_input waits under auto-review', () => {
    expect(
      shouldSuppressCodexAutoReviewPermissionAttention({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'request_user_input',
        reviewer: 'auto_review'
      })
    ).toBe(false)
  })

  it('suppresses the synthetic permission title for auto-review and yolo PermissionRequest', () => {
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
        toolName: 'exec_command',
        reviewer: 'user',
        launchConfig: {
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        }
      })
    ).toBe(true)
  })

  it('keeps real questions and non-permission hooks visible under yolo', () => {
    const yoloLaunchConfig = {
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: {}
    }
    expect(
      shouldSuppressCodexPermissionSyntheticTitle({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'PermissionRequest',
        toolName: 'request_user_input',
        reviewer: 'auto_review',
        launchConfig: yoloLaunchConfig
      })
    ).toBe(false)
    expect(
      shouldSuppressCodexPermissionSyntheticTitle({
        agentType: 'codex',
        state: 'waiting',
        hookEventName: 'AfterToolUse',
        toolName: 'exec_command',
        reviewer: 'user',
        launchConfig: yoloLaunchConfig
      })
    ).toBe(false)
  })
})
