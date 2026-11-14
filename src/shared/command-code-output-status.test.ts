import { describe, expect, it, vi } from 'vitest'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'

describe('createCommandCodeOutputStatusDetector', () => {
  it('detects the Command Code banner across PTY chunk boundaries', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('# Command')).toBe(false)
    expect(detector.observe(' Code v0.27.2\r\n')).toBe(false)
    expect(detector.observe('⌘ Parsing...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('detects the Command Code banner when ANSI styling splits the words', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('# C\x1b[35mommand Co\x1b[0mde v0.27.2\r\n')).toBe(false)
    expect(detector.observe('⌘ Parsing...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('does not arm when another agent merely discusses Command Code', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('// Why: Command Code exposes transcript prompts')).toBe(false)
    expect(detector.observe('\r\n✻ Thinking...')).toBe(false)

    expect(onWorking).not.toHaveBeenCalled()
  })

  it('marks Command Code working when active status text is split across PTY chunks', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe('❯ Fix the yellow spinner\r\nExpl')).toBe(false)
    expect(detector.observe('oring...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix the yellow spinner')
  })

  it('does not capture a styled idle composer as the submitted prompt', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe('# Command Code v0.27.3\r\n❯ A\x1b')).toBe(false)
    expect(detector.observe('[27msk your question...\r\n✻ Thinking...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
    expect(onWorking).not.toHaveBeenCalledWith(expect.stringContaining('[27m'))
  })

  it('captures a submitted prompt when styling is split across PTY chunks', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe('❯ Fix the \x1b')).toBe(false)
    expect(detector.observe('[38;2;99;109;131mstatus row\r\n✻ Thinking...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix the status row')
  })

  it('marks Command Code done when a no-tool turn returns to the idle prompt', () => {
    const onWorking = vi.fn()
    const onDone = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking,
      onDone
    })

    expect(detector.observe('❯ say hi\r\n✻ Thinking...')).toBe(true)
    expect(
      detector.observe(
        '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
      )
    ).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('say hi')
    expect(onDone).toHaveBeenCalledWith('say hi')
  })

  it('does not mark the initial idle composer as done before a submitted prompt', () => {
    const onDone = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking: vi.fn(),
      onDone
    })

    expect(detector.observe('# Command Code v0.27.3\r\n❯ Ask your question...')).toBe(false)

    expect(onDone).not.toHaveBeenCalled()
  })

  it('does not treat completed thought text as a working status', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe('❯ Fix the yellow spinner\r\nThought for 1 second')).toBe(false)
    expect(onWorking).not.toHaveBeenCalled()
  })
})
