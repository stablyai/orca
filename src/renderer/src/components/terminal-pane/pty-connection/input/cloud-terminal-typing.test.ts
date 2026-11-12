import { describe, expect, it, vi } from 'vitest'
import { noteCloudTerminalTyping } from './cloud-terminal-typing'

describe('noteCloudTerminalTyping (git as me in a cloud terminal)', () => {
  it('reports keystrokes this desktop’s person typed into a cloud terminal', () => {
    const report = vi.fn()
    expect(noteCloudTerminalTyping('env-cloud', 'git commit\r', true, report)).toBe(true)
    expect(report).toHaveBeenCalledWith('env-cloud')
  })

  it('never counts input nobody typed: query replies, replayed or resubscribed bytes, agent pastes', () => {
    const report = vi.fn()
    // Output echo and a resubscribe's replay never reach the input path as user input; xterm's own
    // replies (cursor position, device attributes) and programmatic writes arrive with wasUserInput false.
    expect(noteCloudTerminalTyping('env-cloud', '\x1b[12;1R', false, report)).toBe(false)
    expect(noteCloudTerminalTyping('env-cloud', 'echo replayed\r', false, report)).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })

  it('ignores focus and mouse reports even when xterm marks them as user input', () => {
    const report = vi.fn()
    expect(noteCloudTerminalTyping('env-cloud', '\x1b[I', true, report)).toBe(false)
    expect(noteCloudTerminalTyping('env-cloud', '\x1b[<0;10;5M', true, report)).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })

  it('does nothing for a pane with no runtime environment (a local terminal)', () => {
    const report = vi.fn()
    expect(noteCloudTerminalTyping(null, 'ls\r', true, report)).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })
})
