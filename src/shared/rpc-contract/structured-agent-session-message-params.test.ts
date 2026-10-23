import { describe, expect, it } from 'vitest'
import {
  MAX_PROMPT_BYTES,
  structuredAgentSessionBlocksTooLarge
} from './structured-agent-session-message-params'

// Clients refuse before Send with words, so they must refuse exactly what a host refuses, including
// older hosts, which measure with Buffer.byteLength.
describe('message size bound', () => {
  const envelope = JSON.stringify([{ type: 'text', text: '' }]).length

  it.each([
    ['ASCII', 'a', 1],
    ['multi-byte', 'é', 2],
    ['astral', '😀', 4]
  ])('agrees with the host at the boundary for %s text', (_name, unit, unitBytes) => {
    const fits = unit.repeat(Math.floor((MAX_PROMPT_BYTES - envelope) / unitBytes))
    for (const text of [fits, `${fits}${unit}`]) {
      const blocks = [{ type: 'text', text }]
      const hostRefuses = Buffer.byteLength(JSON.stringify(blocks), 'utf8') > MAX_PROMPT_BYTES
      expect(structuredAgentSessionBlocksTooLarge(blocks)).toBe(hostRefuses)
    }
  })
})
