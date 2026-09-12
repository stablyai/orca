import { describe, expect, it } from 'vitest'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes
} from './plugin-panel-message-budget'

describe('structuredCloneMessageBytes', () => {
  it('counts strings as UTF-8 bytes', () => {
    expect(structuredCloneMessageBytes('é')).toBe(2)
    expect(structuredCloneMessageBytes('🐋')).toBe(4)
  })

  it('counts binary backing stores instead of JSON object projections', () => {
    const buffer = new ArrayBuffer(128)
    const tinyView = new Uint8Array(buffer, 0, 1)

    expect(structuredCloneMessageBytes(tinyView, 256)).toBeGreaterThanOrEqual(128)
    expect(structuredCloneMessageBytes(new Blob([new Uint8Array(80)]), 256)).toBe(80)
  })

  it('handles cycles and stops walking once the cap is exceeded', () => {
    const cyclic: { self?: unknown; text: string } = { text: 'x'.repeat(100) }
    cyclic.self = cyclic

    expect(structuredCloneMessageBytes(cyclic, 32)).toBe(33)
  })
})

describe('createPanelMessageBudget', () => {
  it('charges oversized traffic against the message-rate budget', () => {
    const budget = createPanelMessageBudget({ maxBytes: 10, maxMessages: 2, perMs: 1_000 })

    expect(budget.admit(0, 11)).toBe('oversized')
    expect(budget.admit(1, 1)).toBeNull()
    expect(budget.admit(2, 1)).toBe('rate_limited')
  })
})
