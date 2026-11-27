import { describe, expect, it } from 'vitest'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'

describe('createCommandCodeOutputStatusDetector', () => {
  it('sees status after a control string cut by the large-chunk scan window', () => {
    const observe = (data: string): boolean =>
      createCommandCodeOutputStatusDetector({
        startupCommand: 'command-code',
        onWorking: () => undefined
      }).observe(data)
    const status = '\n✻ Thinking…\n'

    expect(
      observe(`${'x'.repeat(1000)}\x1b]52;c;${'A'.repeat(6000)}\x07${'y'.repeat(4000)}${status}`)
    ).toBe(true)
    expect(
      observe(`${'x'.repeat(1000)}\x1bPq${'A'.repeat(6000)}\x1b\\${'y'.repeat(4000)}${status}`)
    ).toBe(true)
  })
})
