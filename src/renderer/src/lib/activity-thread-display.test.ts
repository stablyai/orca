import { describe, expect, it } from 'vitest'
import {
  getActivityThreadStatusPreview,
  getActivityThreadTaskTitle,
  getActivityThreadWorkspaceTitle,
  isTerseAgentFollowUpPrompt,
  resolveActivityThreadStatusPreview
} from './activity-thread-display'

describe('isTerseAgentFollowUpPrompt', () => {
  it('flags common short follow-ups', () => {
    expect(isTerseAgentFollowUpPrompt('yes')).toBe(true)
    expect(isTerseAgentFollowUpPrompt('ok proceed')).toBe(true)
    expect(isTerseAgentFollowUpPrompt('Looks good.')).toBe(true)
  })

  it('keeps substantive prompts', () => {
    expect(isTerseAgentFollowUpPrompt('Compare gpt5 claude prompting')).toBe(false)
    expect(isTerseAgentFollowUpPrompt('Skill creator codex port')).toBe(false)
  })
})

describe('getActivityThreadWorkspaceTitle', () => {
  it('prefers the stored display name', () => {
    expect(
      getActivityThreadWorkspaceTitle({
        displayName: 'Compound engineering plugin',
        branch: 'main'
      })
    ).toBe('Compound engineering plugin')
  })
})

describe('getActivityThreadTaskTitle', () => {
  const tab = {
    customTitle: null,
    generatedTitle: 'Refactor auth middleware',
    title: 'Claude',
    defaultTitle: 'Claude'
  }

  it('prefers custom title, then sticky orchestration labels', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'yes',
          stateHistory: [],
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            displayName: 'Fix checkout race'
          }
        },
        tab: { ...tab, customTitle: 'My rename' },
        generatedTitlesEnabled: true
      })
    ).toBe('My rename')

    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: 'yes', stateHistory: [] },
        tab,
        generatedTitlesEnabled: true
      })
    ).toBe('Refactor auth middleware')
  })

  it('ignores terse live prompts and uses generated title or history', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'yes',
          stateHistory: [{ state: 'working', prompt: 'Skill creator codex port', startedAt: 1 }]
        },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: true
      })
    ).toBe('Skill creator codex port')
  })

  it('picks the most recent substantive prompt from history, not the longest', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'yes',
          stateHistory: [
            {
              state: 'done',
              prompt: 'Refactor the entire authentication middleware layer',
              startedAt: 1
            },
            { state: 'working', prompt: 'Fix logout', startedAt: 2 }
          ]
        },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: false
      })
    ).toBe('Fix logout')
  })

  it('ignores the generated title when generated titles are disabled', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'yes',
          stateHistory: [{ state: 'working', prompt: 'Wire up the export button', startedAt: 1 }]
        },
        tab,
        generatedTitlesEnabled: false
      })
    ).toBe('Wire up the export button')
  })

  it('keeps orchestration labels across terse follow-ups but yields to new work', () => {
    const orchestration = {
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      displayName: 'Fix checkout race'
    }
    // Terse follow-up → still the same orchestration task.
    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: 'yes', stateHistory: [], orchestration },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: false
      })
    ).toBe('Fix checkout race')
    // Substantive non-dispatch prompt → pane moved on; stale label must not pin.
    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: 'Investigate the flaky login test', stateHistory: [], orchestration },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: false
      })
    ).toBe('Investigate the flaky login test')
  })

  it('parses dispatch task bodies from history when the live prompt is a follow-up', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'ok',
          stateHistory: [
            {
              state: 'done',
              prompt: `You are working inside Orca, a multi-agent IDE. Your task ID is: task-1

=== TASK ===
Compare gpt5 claude prompting`,
              startedAt: 1
            }
          ]
        },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: false
      })
    ).toBe('Compare gpt5 claude prompting')
  })
})

describe('getActivityThreadStatusPreview', () => {
  it('shows tool activity while working and assistant replies otherwise', () => {
    expect(
      getActivityThreadStatusPreview({
        state: 'working',
        toolName: 'Bash',
        toolInput: 'pnpm test',
        prompt: 'Run tests'
      })
    ).toBe('Bash: pnpm test')

    expect(
      getActivityThreadStatusPreview(
        {
          state: 'done',
          prompt: 'yes',
          lastAssistantMessage: 'Implemented the skill creator port.'
        },
        'done'
      )
    ).toBe('Implemented the skill creator port.')
  })

  it('rejects hook previews that echo the live user prompt', () => {
    expect(
      getActivityThreadStatusPreview({
        state: 'working',
        prompt: 'yes',
        lastAssistantMessage: 'yes'
      })
    ).toBe('')
  })

  it('surfaces interrupted sessions explicitly', () => {
    expect(
      getActivityThreadStatusPreview({
        state: 'done',
        interrupted: true,
        prompt: 'Ship it'
      })
    ).toBe('Interrupted by user')
  })
})

describe('resolveActivityThreadStatusPreview', () => {
  it('keeps the previous assistant preview when a new ping mislabels the user prompt', () => {
    expect(
      resolveActivityThreadStatusPreview(
        {
          state: 'working',
          prompt: 'yes',
          lastAssistantMessage: 'yes'
        },
        'working',
        'Implemented the skill creator port.'
      )
    ).toBe('Implemented the skill creator port.')
  })
})
