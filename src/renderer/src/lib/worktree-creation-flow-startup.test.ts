import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from './worktree-creation-flow-startup'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

const PROMPT = 'do the thing'

function buildRequest(overrides: Partial<WorktreeCreationRequest>): WorktreeCreationRequest {
  return {
    agent: 'claude',
    startupPlan: { agent: 'claude', launchCommand: 'claude' } as never,
    quickPrompt: PROMPT,
    quickTelemetry: null,
    name: 'wt',
    setupDecision: 'skip',
    pendingFirstAgentMessageRename: false,
    note: '',
    ...overrides
  } as WorktreeCreationRequest
}

describe('buildWorktreeCreationStartupOpt', () => {
  it('auto-submits the startup prompt for any agent when createAndRun is set', () => {
    const opt = buildWorktreeCreationStartupOpt(buildRequest({ createAndRun: true }), false)
    expect(opt?.initialAgentStatus).toEqual({ agent: 'claude', prompt: PROMPT })
  })

  it('does not auto-submit for a non-command-code agent when createAndRun is off', () => {
    const opt = buildWorktreeCreationStartupOpt(buildRequest({ createAndRun: false }), false)
    expect(opt?.initialAgentStatus).toBeUndefined()
  })

  it('keeps auto-submitting for command-code even without the toggle', () => {
    const opt = buildWorktreeCreationStartupOpt(
      buildRequest({ agent: 'command-code', createAndRun: false }),
      false
    )
    expect(opt?.initialAgentStatus).toEqual({ agent: 'command-code', prompt: PROMPT })
  })

  it('never auto-submits when there is no startup prompt', () => {
    const opt = buildWorktreeCreationStartupOpt(
      buildRequest({ createAndRun: true, quickPrompt: '   ' }),
      false
    )
    expect(opt?.initialAgentStatus).toBeUndefined()
  })
})
