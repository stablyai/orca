import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from './worktree-creation-flow-startup'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

function makeRequest(overrides: Partial<WorktreeCreationRequest>): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'wt',
    quickPrompt: '',
    startupPlan: { launchCommand: 'codex', launchConfig: undefined },
    ...overrides
  } as WorktreeCreationRequest
}

// Why: Codex posts no hook while its TUI idles (measured on codex-cli 0.147 —
// SessionStart fires only alongside the first UserPromptSubmit), so a new
// workspace's first pane stays absent from the status surface unless the launch
// metadata carries the spawn-window row (#6643).
describe('buildWorktreeCreationStartupOpt launch-status seed', () => {
  it('seeds a working row for a Codex workspace created with a prompt', () => {
    const startup = buildWorktreeCreationStartupOpt(
      makeRequest({ agent: 'codex', quickPrompt: '  fix the spinner  ' }),
      false
    )

    expect(startup?.initialAgentStatus).toEqual({ agent: 'codex', prompt: 'fix the spinner' })
  })

  it('seeds a promptless Codex workspace so the pane is present at spawn', () => {
    const startup = buildWorktreeCreationStartupOpt(makeRequest({ agent: 'codex' }), false)

    expect(startup?.initialAgentStatus).toEqual({ agent: 'codex', prompt: '' })
  })

  it('does not claim a running turn when the prompt rides as an unsent draft', () => {
    const startup = buildWorktreeCreationStartupOpt(
      makeRequest({
        agent: 'codex',
        quickPrompt: 'fix the spinner',
        startupPlan: {
          launchCommand: 'codex',
          draftPrompt: 'fix the spinner'
        } as WorktreeCreationRequest['startupPlan']
      }),
      false
    )

    expect(startup?.initialAgentStatus).toEqual({ agent: 'codex', prompt: '' })
  })

  it('leaves agents that publish a startup row unseeded', () => {
    const startup = buildWorktreeCreationStartupOpt(
      makeRequest({ agent: 'claude', quickPrompt: 'fix the spinner' }),
      false
    )

    expect(startup?.initialAgentStatus).toBeUndefined()
  })

  it('seeds nothing when the backend already spawned the first terminal', () => {
    const startup = buildWorktreeCreationStartupOpt(
      makeRequest({ agent: 'codex', quickPrompt: 'fix the spinner' }),
      true
    )

    expect(startup).toBeUndefined()
  })
})
