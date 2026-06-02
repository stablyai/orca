import { describe, expect, it } from 'vitest'
import { getAutomationRunStatusLabel, getAutomationRunStatusVariant } from './automation-page-parts'

describe('automation run status display', () => {
  it('labels duplicate startup skips as already running', () => {
    expect(getAutomationRunStatusLabel('skipped_duplicate')).toBe('Already running')
    expect(getAutomationRunStatusVariant('skipped_duplicate')).toBe('outline')
  })
})
