import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS,
  createLinearAgentSkillSetupActivationId,
  getExistingLinearAgentSkillSetupReminderState,
  getLinearAgentSkillSetupReminderState,
  getLinearAgentSkillSetupReminderStateCountForTests,
  hasLinearAgentSkillSetupReminderStateForTests,
  resetLinearAgentSkillSetupReminderState
} from './linear-agent-skill-setup-reminders'

afterEach(() => {
  resetLinearAgentSkillSetupReminderState()
})

describe('linear agent skill setup reminders', () => {
  it('bounds runtime reminder state through prolonged key churn', () => {
    const churnedRuntimeCount = MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS * 4
    for (let i = 0; i < churnedRuntimeCount; i += 1) {
      getLinearAgentSkillSetupReminderState(`runtime-${i}`)
    }

    expect(getLinearAgentSkillSetupReminderStateCountForTests()).toBe(
      MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS
    )
    expect(hasLinearAgentSkillSetupReminderStateForTests('runtime-0')).toBe(false)
    expect(hasLinearAgentSkillSetupReminderStateForTests(`runtime-${churnedRuntimeCount - 1}`)).toBe(
      true
    )
  })

  it('retains recently reused keys while trimming', () => {
    getLinearAgentSkillSetupReminderState('keep').modalShown = true
    for (let i = 0; i < MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS - 1; i += 1) {
      getLinearAgentSkillSetupReminderState(`runtime-${i}`).toastCount = 1
    }

    expect(getLinearAgentSkillSetupReminderState('keep').modalShown).toBe(true)

    getLinearAgentSkillSetupReminderState('runtime-new')

    expect(getLinearAgentSkillSetupReminderStateCountForTests()).toBe(
      MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS
    )
    expect(hasLinearAgentSkillSetupReminderStateForTests('runtime-0')).toBe(false)
    expect(getLinearAgentSkillSetupReminderState('keep').modalShown).toBe(true)
  })

  it('keeps active toast state ahead of inactive stale entries when trimming', () => {
    getLinearAgentSkillSetupReminderState('toast-active').activeToastId = 'toast-id'
    for (let i = 0; i < MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS; i += 1) {
      getLinearAgentSkillSetupReminderState(`runtime-${i}`)
    }

    expect(getLinearAgentSkillSetupReminderStateCountForTests()).toBe(
      MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS
    )
    expect(hasLinearAgentSkillSetupReminderStateForTests('toast-active')).toBe(true)
    expect(hasLinearAgentSkillSetupReminderStateForTests('runtime-0')).toBe(false)
  })

  it('retains a new key when every existing entry has an active toast', () => {
    for (let i = 0; i < MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS; i += 1) {
      getLinearAgentSkillSetupReminderState(`runtime-${i}`).activeToastId = `toast-${i}`
    }

    const newState = getLinearAgentSkillSetupReminderState('runtime-new')

    expect(getLinearAgentSkillSetupReminderStateCountForTests()).toBe(
      MAX_LINEAR_AGENT_SKILL_SETUP_REMINDER_RUNTIME_KEYS
    )
    expect(hasLinearAgentSkillSetupReminderStateForTests('runtime-0')).toBe(false)
    expect(getExistingLinearAgentSkillSetupReminderState('runtime-new')).toBe(newState)
  })

  it('does not create reminder state when peeking at a missing key', () => {
    expect(getExistingLinearAgentSkillSetupReminderState('missing')).toBeUndefined()
    expect(getLinearAgentSkillSetupReminderStateCountForTests()).toBe(0)
  })

  it('resets activation ids with reminder state for tests', () => {
    expect(createLinearAgentSkillSetupActivationId()).toBe('linear-agent-skill-setup-0')
    expect(createLinearAgentSkillSetupActivationId()).toBe('linear-agent-skill-setup-1')

    resetLinearAgentSkillSetupReminderState()

    expect(createLinearAgentSkillSetupActivationId()).toBe('linear-agent-skill-setup-0')
  })
})
