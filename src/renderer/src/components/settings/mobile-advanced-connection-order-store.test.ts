// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadMobileAdvancedConnectionOrderEnabled,
  saveMobileAdvancedConnectionOrderEnabled
} from './mobile-advanced-connection-order-store'

describe('mobile advanced connection order store', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults off and persists an explicit opt-in', () => {
    expect(loadMobileAdvancedConnectionOrderEnabled()).toBe(false)

    saveMobileAdvancedConnectionOrderEnabled(true)
    expect(loadMobileAdvancedConnectionOrderEnabled()).toBe(true)

    saveMobileAdvancedConnectionOrderEnabled(false)
    expect(loadMobileAdvancedConnectionOrderEnabled()).toBe(false)
  })
})
