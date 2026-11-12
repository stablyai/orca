import { describe, expect, it } from 'vitest'
import { isFirstRunWelcomeShown } from './right-sidebar-visibility'

const home = {
  activeView: 'terminal' as const,
  hasActiveWorktree: false,
  creationLayoutActive: false,
  projectCount: 0
}

describe('first-run welcome hides the right sidebar', () => {
  it('only on Home with no project, no workspace and no creation in progress', () => {
    expect(isFirstRunWelcomeShown(home)).toBe(true)
    expect(isFirstRunWelcomeShown({ ...home, projectCount: 1 })).toBe(false)
    expect(isFirstRunWelcomeShown({ ...home, hasActiveWorktree: true })).toBe(false)
    expect(isFirstRunWelcomeShown({ ...home, creationLayoutActive: true })).toBe(false)
    expect(isFirstRunWelcomeShown({ ...home, activeView: 'tasks' })).toBe(false)
  })
})
