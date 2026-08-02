import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  getAgentRowGeneratedTitleText,
  getAgentRowPrimaryText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt
} from './agent-row-primary-text'

describe('getAgentRowPrimaryText', () => {
  it('prefers orchestration display name over the raw hook prompt', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'You are working inside Orca, a multi-agent IDE.',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race',
          displayName: 'Fix checkout race'
        }
      })
    ).toBe('Fix checkout race')
  })

  it('falls back to task title when display name is absent', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'You are working inside Orca, a multi-agent IDE.',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race'
        }
      })
    ).toBe('Checkout race')
  })

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

  it('uses the task block when orchestration metadata has not arrived yet', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: term_parent
Your task ID is: task_1

=== CLI COMMANDS ===
orca orchestration send --to term_parent

=== TASK ===
Review dispatch prompts and make worker labels distinct

Keep the raw preamble out of the sidebar.`
      })
    ).toBe('Review dispatch prompts and make worker labels distinct')
  })

  it('falls back to the raw prompt outside orchestration workers', () => {
    expect(getAgentRowPrimaryText({ prompt: 'Fix checkout race' })).toBe('Fix checkout race')
  })

  // Why: production status prompts reach these helpers already folded to a
  // single line and capped at 200 chars by normalizeAgentStatusPayload. Guard
  // the real normalized shape — earlier tests only fed raw multi-line prompts,
  // which hid that the task-id parser split on \n and never matched.
  it('matches orchestration labels on a normalized single-line dispatch prompt', () => {
    const normalized = normalizeAgentStatusPayload({
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: term_parent
Your task ID is: task_9f3ab2

You talk to the coordinator only through the CLI commands below.

=== TASK ===
Fix the checkout race condition in payments`
    })
    expect(normalized).not.toBeNull()
    expect(
      getAgentRowPrimaryText({
        prompt: normalized!.prompt,
        orchestration: {
          taskId: 'task_9f3ab2',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race',
          displayName: 'Fix checkout race'
        }
      })
    ).toBe('Fix checkout race')
  })

  // Why: full preambles bury === TASK === after multi-KB CLI instructions. The
  // status normalizer must compact the field so a missing/delayed label still
  // yields a meaningful task preview from the single-line 200-char prompt.
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

  it('uses a short single-line task body as the fallback preview', () => {
    const normalized = normalizeAgentStatusPayload({
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE.
Your task ID is: task_short

=== TASK ===
Fix login form`
    })
    expect(getAgentRowPrimaryText({ prompt: normalized!.prompt })).toBe('Fix login form')
  })

  it('prefers later orchestration labels over the extracted task preview', () => {
    const normalized = normalizeAgentStatusPayload({
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task_label_later

=== CLI COMMANDS ===
${'orca orchestration check\n'.repeat(30)}
=== TASK ===
Implement the detailed worker instructions that should not stay as the final label`
    })
    expect(normalized).not.toBeNull()

    expect(getAgentRowPrimaryText({ prompt: normalized!.prompt })).toContain(
      'Implement the detailed worker instructions'
    )

    expect(
      getAgentRowPrimaryText({
        prompt: normalized!.prompt,
        orchestration: {
          taskId: 'task_label_later',
          dispatchId: 'ctx-later',
          taskTitle: 'Worker instructions',
          displayName: 'Better worker label'
        }
      })
    ).toBe('Better worker label')
  })

  it('does not surface preamble boilerplate when the TASK marker is absent', () => {
    expect(
      getAgentRowPrimaryText({
        prompt:
          'You are working inside Orca, a multi-agent IDE. You are a dispatched worker. Your task ID is: task_no_body CLI noise only'
      })
    ).toBe('')
  })

  // Why: UI helpers still accept raw multi-line preambles (tests, defensive
  // paths). Without the standalone-line marker rule, a base-drift subject that
  // mentions `=== TASK ===` wins over Orca's real separator.
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

  it('still reads the task body from a normalized single-line compact prompt', () => {
    expect(
      getAgentRowPrimaryText({
        prompt:
          'You are working inside Orca, a multi-agent IDE. Your task ID is: task_inline === TASK === Compact body preview'
      })
    ).toBe('Compact body preview')
  })
})

describe('getOrcaDispatchTaskId', () => {
  it('extracts the id when the trailing newline was folded to a space', () => {
    const normalized = normalizeAgentStatusPayload({
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task_9f3ab2

=== TASK ===
body`
    })
    expect(getOrcaDispatchTaskId(normalized!.prompt)).toBe('task_9f3ab2')
  })

  it('extracts the id from a raw multi-line prompt', () => {
    expect(
      getOrcaDispatchTaskId(
        `You are working inside Orca, a multi-agent IDE.\nYour task ID is: task_1\n\n=== TASK ===\nbody`
      )
    ).toBe('task_1')
  })
})

describe('isOrcaDispatchPrompt / getAgentRowGeneratedTitleText', () => {
  it('treats leading whitespace as still a dispatch preamble', () => {
    expect(
      isOrcaDispatchPrompt('  You are working inside Orca, a multi-agent IDE. Worker task')
    ).toBe(true)
  })

  it('uses orchestration labels for generated titles only on matching dispatch prompts', () => {
    expect(
      getAgentRowGeneratedTitleText({
        prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-1

=== TASK ===
Checkout race body`,
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race',
          displayName: 'Fix checkout race'
        }
      })
    ).toBe('Fix checkout race')
  })

  it('ignores sticky orchestration for non-dispatch generated titles', () => {
    expect(
      getAgentRowGeneratedTitleText({
        prompt: 'Refactor the auth middleware',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Stale task',
          displayName: 'Stale worker label'
        }
      })
    ).toBe('Refactor the auth middleware')
  })
})
