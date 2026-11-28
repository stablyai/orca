import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './listener-state'
import { resolvePrompt } from './prompt-fields'
import { hasExplicitUserPrompt } from './provider-event-routing'

const PANE = 'pane-a'
const ENVELOPED_TASK = '<hook_result hook_event="UserPromptSubmit">{}</hook_result>\nFix CI config'
const HARNESS_ONLY = '<hook_result hook_event="UserPromptSubmit">{}</hook_result>'

describe('prompt submission behind a leading harness envelope', () => {
  it('stores the task after the envelope and keeps harness-only turns on the previous prompt', () => {
    const state = createHookListenerState()
    expect(resolvePrompt(state, PANE, 'earlier task')).toBe('earlier task')

    expect(resolvePrompt(state, PANE, ENVELOPED_TASK)).toBe('Fix CI config')
    expect(state.lastPromptByPaneKey.get(PANE)).toBe('Fix CI config')

    expect(resolvePrompt(state, PANE, HARNESS_ONLY, { resetOnNewTurn: true })).toBe('Fix CI config')
  })

  it('routes the enveloped task as a user submission but not a harness-only turn', () => {
    const submitted = (text: string) =>
      hasExplicitUserPrompt('claude', 'UserPromptSubmit', { text, source: 'prompt' }, text)
    expect(submitted(ENVELOPED_TASK)).toBe(true)
    expect(submitted(HARNESS_ONLY)).toBe(false)
    expect(submitted('[Request interrupted by user]')).toBe(false)
  })
})
