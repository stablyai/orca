import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-detection'

describe('getAgentLabel', () => {
  it('recognizes Mimo from braille-spinner titles', () => {
    expect(getAgentLabel('⠋ Mimo')).toBe('Mimo')
  })

  it('rejects hyphenated mimo compounds as false positives', () => {
    expect(getAgentLabel('mimo-blinker')).toBeNull()
  })
})
