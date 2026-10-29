import { describe, expect, it } from 'vitest'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'

describe('structuredCloneMessageBytes', () => {
  it('counts binary backing stores instead of JSON object projections', () => {
    const buffer = new ArrayBuffer(128)
    const tinyView = new Uint8Array(buffer, 0, 1)

    expect(structuredCloneMessageBytes(tinyView, 256)).toBeGreaterThanOrEqual(128)
    expect(structuredCloneMessageBytes(new Blob([new Uint8Array(80)]), 256)).toBe(80)
  })
})
