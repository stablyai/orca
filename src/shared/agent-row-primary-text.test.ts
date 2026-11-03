import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusPayload } from './agent-status-types'
import { getAgentRowPrimaryText } from './agent-row-primary-text'

describe('getAgentRowPrimaryText', () => {
  it('ignores sticky orchestration labels that belong to a different task id', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task_2

=== TASK ===
Review dispatch prompts and make worker labels distinct`,
        orchestration: {
          taskId: 'task_1',
          dispatchId: 'ctx-1',
          taskTitle: 'Stale task',
          displayName: 'Stale worker label'
        }
      })
    ).toBe('Review dispatch prompts and make worker labels distinct')
  })

  // The normalizer must preserve a meaningful task preview within 200 chars despite multi-KB dispatch preambles.
  it('derives a task preview from a normalized 200-char dispatch prompt without labels', () => {
    const longCliNoise = Array.from(
      { length: 40 },
      (_, i) => `orca orchestration send --to term_parent --type heartbeat --phase step-${i}`
    ).join('\n')
    const taskBody =
      'Release-fix task: orchestration fallback task preview for single-line normalization'
    const normalized = normalizeAgentStatusPayload({
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: term_c376f37c-5d28-404b-869f-d0544edf12ff
Your task ID is: task_bcfc6b64abe3

You talk to the coordinator only through the CLI commands below.

=== CLI COMMANDS ===
${longCliNoise}

=== TASK ===
${taskBody}`
    })
    expect(normalized).not.toBeNull()
    expect(normalized!.prompt.length).toBeLessThanOrEqual(200)
    expect(normalized!.prompt.includes('\n')).toBe(false)
    expect(normalized!.prompt).not.toContain('CLI COMMANDS')
    expect(normalized!.prompt).toContain('=== TASK ===')

    const preview = getAgentRowPrimaryText({ prompt: normalized!.prompt })
    expect(preview).toContain('orchestration fallback task preview')
    expect(preview).not.toContain('You are working inside Orca')
    expect(preview).not.toContain('CLI COMMANDS')
  })

  // Raw preambles need standalone markers so base-drift subjects mentioning === TASK === cannot win.
  it('ignores adversarial === TASK === text in raw multi-line base-drift subjects', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: [
          'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
          'Your task ID is: task_raw_drift',
          '',
          '--- BASE DRIFT ---',
          '  - docs: explain === TASK === marker parsing',
          '---',
          '',
          '=== TASK ===',
          'Fix the actual dispatch fallback preview'
        ].join('\n')
      })
    ).toBe('Fix the actual dispatch fallback preview')
  })
})
