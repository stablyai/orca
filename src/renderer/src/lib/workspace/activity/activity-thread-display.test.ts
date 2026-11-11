import { describe, expect, it } from 'vitest'
import {
  getActivityThreadStatusPreview,
  getActivityThreadTaskTitle,
  resolveActivityThreadStatusPreview
} from './activity-thread-display'

describe('getActivityThreadTaskTitle', () => {
  const tab = {
    customTitle: null,
    generatedTitle: 'Refactor auth middleware',
    title: 'Claude',
    defaultTitle: 'Claude'
  }

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

  it('skips pasted data for the newest prompt the user wrote', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: '{ "tool": "orca diagnostics", "takenAt": "2026"',
          stateHistory: [{ state: 'done', prompt: 'Fix logout', startedAt: 1 }]
        },
        tab: { ...tab, generatedTitle: undefined },
        generatedTitlesEnabled: false
      })
    ).toBe('Fix logout')
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
})

describe('getActivityThreadStatusPreview', () => {
  it('keeps a resolved tool off a finished row', () => {
    // Tool fields outlive their turn; showing them after completion implies work is still in flight.
    for (const state of ['done', 'blocked'] as const) {
      expect(
        getActivityThreadStatusPreview({
          state,
          toolName: 'bash',
          toolInput: 'rm -rf build/',
          prompt: 'Clean the build'
        })
      ).toBe('')
    }
  })

  it('does not show a prior completed reply while the agent is working', () => {
    expect(
      getActivityThreadStatusPreview({
        state: 'working',
        prompt: 'Next turn',
        lastCompletedAssistantMessage: 'Filed 8 issues from the audit.'
      })
    ).toBe('')
  })

  it('falls through to the completed-turn reply when the live preview is only worker_done', () => {
    expect(
      getActivityThreadStatusPreview({
        state: 'done',
        prompt: 'Fix checkout',
        lastAssistantMessage: 'Done — worker_done sent with outcome succeeded.',
        lastCompletedAssistantMessage: 'I updated the tests and checked the activity row.'
      })
    ).toBe('I updated the tests and checked the activity row.')
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
