import { describe, expect, it } from 'vitest'
import { createPtyOutputProcessor } from './pty-output-processor'
const osc7501 = (body: string): string => `\x1b]7501;${body}\x1b\\`

describe('renderer-owned PTY output after an OSC 7501 program ends', () => {
  it("hands the pane back to title glyphs once the shell prompt returns after a program's done", () => {
    const events: string[] = []
    const processor = createPtyOutputProcessor({
      onTitleChange: () => {},
      onAgentBecameIdle: (title) => events.push(`idle:${title}`),
      onAgentBecameWorking: () => events.push('working')
    })
    const callbacks = { onData: () => {} }
    processor.processData(osc7501('state=working:app=terraform'), callbacks)
    processor.processData(osc7501('state=done:app=terraform'), callbacks)
    processor.processData('\x1b]133;A\x07\x1b]0;zsh\x07', callbacks)
    processor.processData('\x1b]0;⠋ Gemini working\x07', callbacks)
    processor.processData('\x1b]0;◇ Gemini ready\x07', callbacks)
    processor.flushPendingSideEffects()
    expect(events).toEqual(['working', 'idle:', 'working', 'idle:◇ Gemini ready'])
  })
})
