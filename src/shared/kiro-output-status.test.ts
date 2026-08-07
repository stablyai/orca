import { describe, expect, it } from 'vitest'
import { createKiroOutputStatusDetector } from './kiro-output-status'

const ESC = String.fromCharCode(0x1b)
const KIRO_UI = 'ask a question or describe a task ↵'
const WORKING = 'Thinking... (esc to cancel)'
const DONE = 'Credits: 0.42 • Time: 12.3 s'

function trackDetector(args?: { startupCommand?: string; knownKiroSession?: boolean }) {
  const calls: string[] = []
  const detector = createKiroOutputStatusDetector({
    ...args,
    onWorking: () => calls.push('working'),
    onDone: () => calls.push('done')
  })
  return { calls, observe: detector.observe }
}

describe('kiro output status detector', () => {
  it('ignores status-shaped output until the Kiro UI is seen', () => {
    const { calls, observe } = trackDetector()
    expect(observe(`${WORKING}\n${DONE}\n`)).toBe(false)
    expect(calls).toEqual([])
  })

  it('reports working then done once the Kiro UI is seen', () => {
    const { calls, observe } = trackDetector()
    observe(`${KIRO_UI}\n`)
    observe(`${WORKING}\n`)
    observe(`${DONE}\n`)
    expect(calls).toEqual(['working', 'done'])
  })

  it('ignores a done line with no in-flight turn', () => {
    const { calls, observe } = trackDetector()
    observe(`${KIRO_UI}\n`)
    expect(observe(`${DONE}\n`)).toBe(false)
    expect(calls).toEqual([])
  })

  // Why: the PTY splits at arbitrary byte offsets, so a status line routinely straddles two chunks.
  it('detects a status line split across chunks', () => {
    const { calls, observe } = trackDetector()
    observe(`${KIRO_UI}\n`)
    observe('Thinki')
    observe('ng... (esc to cancel)\n')
    observe('Credits: 0.42 • Ti')
    observe('me: 12.3 s\n')
    expect(calls).toEqual(['working', 'done'])
  })

  // Why: the carry window re-scans prior text, so a settled match must not fire again.
  it('fires once per turn across consecutive turns', () => {
    const { calls, observe } = trackDetector()
    observe(`${KIRO_UI}\n`)
    observe(`${WORKING}\n`)
    observe('tool output\n')
    observe(`${DONE}\n`)
    observe('more output\n')
    observe(`${WORKING}\n`)
    observe(`${DONE}\n`)
    expect(calls).toEqual(['working', 'done', 'working', 'done'])
  })

  it('trusts a known Kiro startup command without waiting for the UI', () => {
    const { calls, observe } = trackDetector({ startupCommand: 'kiro-cli chat --tui' })
    observe(`${WORKING}\n`)
    observe(`${DONE}\n`)
    expect(calls).toEqual(['working', 'done'])
  })

  it('detects status lines wrapped in ANSI control sequences', () => {
    const { calls, observe } = trackDetector({ knownKiroSession: true })
    observe(`${ESC}[1mThinking...${ESC}[0m (esc to cancel)\r\n`)
    observe(`${ESC}[2K${ESC}[32mCredits: 0.42 • Time: 12.3 s${ESC}[0m\r\n`)
    expect(calls).toEqual(['working', 'done'])
  })
})
