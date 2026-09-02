import { describe, expect, it } from 'vitest'
import { shouldShowAgentsSidebar } from './agents-sidebar-visibility'

describe('shouldShowAgentsSidebar', () => {
  it('hides while settings are not yet hydrated', () => {
    expect(shouldShowAgentsSidebar(null)).toBe(false)
    expect(shouldShowAgentsSidebar(undefined)).toBe(false)
  })

  it('defaults on and honors only the dedicated setting', () => {
    expect(shouldShowAgentsSidebar({})).toBe(true)
    expect(shouldShowAgentsSidebar({ showAgentsSidebar: true })).toBe(true)
    expect(shouldShowAgentsSidebar({ showAgentsSidebar: false })).toBe(false)
  })
})
