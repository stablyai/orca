import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureHardeningRetryBudget,
  mayAttemptHardening,
  recordHardeningOutcome
} from './secure-path-hardening-retry-budget'

const PATH = 'C:\\Users\\me\\.orca\\secret.json'
const OTHER = 'C:\\Users\\me\\.orca\\other.json'

describe('secure path hardening retry budget', () => {
  beforeEach(() => {
    configureHardeningRetryBudget({
      maxEntries: 64,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 65_536
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('budgets each path separately', () => {
    recordHardeningOutcome(PATH, false)

    expect(mayAttemptHardening(PATH)).toBe(false)
    expect(mayAttemptHardening(OTHER)).toBe(true)
  })

  /** A second importer may have no configuration; throwing there made async hardening crash main.
   * Import only the budget so secure-file cannot hide the missing defaults. */
  it('defaults its bounds when nothing configured it', async () => {
    vi.resetModules()
    const budget = await import('./secure-path-hardening-retry-budget.js')

    expect(budget.mayAttemptHardening(PATH)).toBe(true)
    expect(() => budget.recordHardeningOutcome(PATH, false)).not.toThrow()
    expect(budget.mayAttemptHardening(PATH)).toBe(false)
    expect(budget.mayAttemptHardening(OTHER)).toBe(true)
  })
})
