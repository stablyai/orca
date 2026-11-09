import { describe, expect, it } from 'vitest'
import {
  automationActionAvailability,
  isAutomationActionEnabled
} from './automation-captured-owner'

describe('captured owner availability', () => {
  it('keeps delete and pause fenceable on an orphan while refusing to run it', () => {
    const orphan = { owner: null, selector: { kind: 'orphan' as const, issue: 'gone' } }
    expect(automationActionAvailability(orphan, 'delete')).toEqual({
      kind: 'orphan-fenced',
      precondition: { selector: { kind: 'orphan' } }
    })
    expect(automationActionAvailability(orphan, 'toggle').kind).toBe('orphan-fenced')
    expect(automationActionAvailability(orphan, 'run').kind).toBe('blocked')
    expect(automationActionAvailability(orphan, 'edit').kind).toBe('blocked')
    expect(isAutomationActionEnabled(orphan, 'run')).toBe(false)
    expect(isAutomationActionEnabled(orphan, 'delete')).toBe(true)
  })
})
