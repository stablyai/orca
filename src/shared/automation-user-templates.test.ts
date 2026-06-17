import { describe, expect, it } from 'vitest'
import {
  buildUserAutomationTemplate,
  normalizeUserAutomationTemplate
} from './automation-user-templates'

describe('buildUserAutomationTemplate', () => {
  it('trims fields and normalizes the agent config', () => {
    const template = buildUserAutomationTemplate(
      {
        label: '  Nightly  ',
        name: '  Deploy check ',
        prompt: 'do it',
        agentId: 'claude',
        agentConfig: { model: ' opus ', launchArgs: '' },
        preset: 'daily',
        time: '02:00',
        missedRunGraceMinutes: '60'
      },
      { id: 't1', createdAt: 100, now: 200 }
    )
    expect(template.label).toBe('Nightly')
    expect(template.name).toBe('Deploy check')
    expect(template.agentConfig).toEqual({ model: 'opus' })
    expect(template.dayOfWeek).toBeNull()
    expect(template.updatedAt).toBe(200)
  })

  it('coerces non-string fields instead of throwing (malformed IPC input)', () => {
    const template = buildUserAutomationTemplate(
      {
        label: null as never,
        name: undefined as never,
        prompt: 123 as never,
        agentId: 'claude',
        preset: 'daily'
      },
      { id: 't0', createdAt: 0, now: 0 }
    )
    expect(template.label).toBe('Untitled template')
    expect(template.name).toBe('')
    expect(template.prompt).toBe('')
  })

  it('falls back to defaults for invalid label/agent/preset', () => {
    const template = buildUserAutomationTemplate(
      {
        label: '   ',
        name: '',
        prompt: '',
        agentId: 'not-an-agent' as never,
        preset: 'nonsense' as never
      },
      { id: 't2', createdAt: 0, now: 0 }
    )
    expect(template.label).toBe('Untitled template')
    expect(template.agentId).toBe('claude')
    expect(template.preset).toBe('daily')
  })
})

describe('normalizeUserAutomationTemplate', () => {
  it('rejects values without an id', () => {
    expect(normalizeUserAutomationTemplate(null)).toBeNull()
    expect(normalizeUserAutomationTemplate({})).toBeNull()
    expect(normalizeUserAutomationTemplate({ label: 'x' })).toBeNull()
  })

  it('round-trips a stored template', () => {
    const stored = {
      id: 't3',
      label: 'Weekly review',
      description: 'desc',
      name: 'Review',
      prompt: 'review',
      agentId: 'codex',
      agentConfig: { model: 'gpt-5' },
      preset: 'weekly',
      time: '09:00',
      dayOfWeek: '4',
      customSchedule: null,
      missedRunGraceMinutes: '1440',
      createdAt: 5,
      updatedAt: 9
    }
    expect(normalizeUserAutomationTemplate(stored)).toEqual(stored)
  })
})
