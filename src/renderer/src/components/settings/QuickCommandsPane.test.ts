import { describe, expect, it } from 'vitest'
import { shouldOpenQuickCommandAddIntent } from './QuickCommandsPane'

describe('QuickCommandsPane add-command intent', () => {
  it('opens the add flow once for each new intent signal', () => {
    expect(shouldOpenQuickCommandAddIntent(undefined, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(0, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(1, 0)).toBe(true)
    expect(shouldOpenQuickCommandAddIntent(1, 1)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(2, 1)).toBe(true)
  })
})
