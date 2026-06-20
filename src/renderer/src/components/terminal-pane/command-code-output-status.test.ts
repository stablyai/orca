import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCommandCodeOutputStatusDetector', () => {
  it('marks Command Code working with the submitted prompt when the TUI starts thinking', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe('❯ Fix the yellow spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix the yellow spinner')
  })

  it('waits for the Command Code banner before trusting generic status text', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('Thinking about unrelated shell output')).toBe(false)
    expect(detector.observe('# Command Code v0.27.2')).toBe(false)
    expect(detector.observe('⌘ Parsing...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('detects the Command Code banner across PTY chunk boundaries', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('# Command')).toBe(false)
    expect(detector.observe(' Code v0.27.2')).toBe(false)
    expect(detector.observe('⌘ Parsing...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('detects the Command Code banner when ANSI styling splits the words', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('# C\x1b[35mommand Co\x1b[0mde v0.27.2')).toBe(false)
    expect(detector.observe('⌘ Parsing...')).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('does not trust near-miss Command Code banner text', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('NotCommand CodeX\r\n⌘ Parsing...')).toBe(false)

    expect(onWorking).not.toHaveBeenCalled()
  })

  it.each([
    'Pondering',
    'Contemplating',
    'Reasoning',
    'Reflecting',
    'Considering',
    'Deliberating',
    'Analyzing',
    'Evaluating',
    'Examining',
    'Inspecting',
    'Investigating',
    'Reviewing',
    'Researching',
    'Studying',
    'Exploring',
    'Mapping',
    'Tracing',
    'Parsing',
    'Processing',
    'Calculating',
    'Computing',
    'Synthesizing',
    'Planning',
    'Outlining',
    'Sketching',
    'Drafting',
    'Composing',
    'Crafting',
    'Building',
    'Assembling',
    'Constructing',
    'Designing',
    'Formulating',
    'Structuring',
    'Organizing',
    'Preparing',
    'Refining',
    'Polishing',
    'Honing',
    'Tuning',
    'Aligning',
    'Connecting',
    'Resolving',
    'Weaving',
    'Threading',
    'Sculpting',
    'Crystallizing',
    'Channeling',
    'Conjuring',
    'Brewing',
    'Working',
    'Cogitating',
    'Ruminating',
    'Hypothesizing',
    'Conceptualizing',
    'Philosophizing',
    'Deciphering',
    'Demystifying',
    'Articulating',
    'Illuminating',
    'Elaborating',
    'Orchestrating',
    'Choreographing',
    'Architecting',
    'Calibrating',
    'Materializing',
    'Visualizing',
    'Harmonizing',
    'Contemplificating',
    'Supercalifragilisting',
    'Bibbidibobbidibooing',
    'Abracadabraing',
    'Hocuspocusing',
    'Razzmatazzing'
  ])('marks Command Code working when the TUI reports %s', (statusText) => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })

    expect(detector.observe(`❯ Fix the yellow spinner\r\n${statusText}...`)).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix the yellow spinner')
  })

  it.each(['Executing: sleep 8 && echo done', '⎿ Running (1s | 0)'])(
    'marks Command Code working when the TUI reports %s',
    (statusText) => {
      const onWorking = vi.fn()
      const detector = createCommandCodeOutputStatusDetector({
        startupCommand: 'command-code --trust',
        onWorking
      })

      expect(detector.observe(`❯ Fix the yellow spinner\r\n${statusText}`)).toBe(true)

      expect(onWorking).toHaveBeenCalledWith('Fix the yellow spinner')
    }
  )

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

  it('folds whitespace-heavy submitted prompts without whitespace regex replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })
    const nonBreakingSpace = String.fromCharCode(160)
    const prompt = `❯ Fix\t  the${nonBreakingSpace}${nonBreakingSpace}status   row\r\n✻ Thinking...`

    expect(detector.observe(prompt)).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix the status row')
    expect(
      replaceSpy.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
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

  it('bounds scan work for large echoed paste output in Command Code terminals', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const matchAllSpy = vi.spyOn(String.prototype, 'matchAll')
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code --trust',
      onWorking
    })
    const largeEchoedPaste = `${'pasted Command Code \x1b[35mnoise\r\n'.repeat(10_000)}❯ Fix bounded scans\r\n✻ Thinking...`

    expect(detector.observe(largeEchoedPaste)).toBe(true)

    expect(onWorking).toHaveBeenCalledWith('Fix bounded scans')
    expect(maxStringContextLength(replaceSpy.mock.contexts)).toBeLessThan(10_000)
    expect(maxStringContextLength(matchAllSpy.mock.contexts)).toBeLessThan(10_000)
  })

  it('bounds pre-banner scans for large non-Command-Code terminal output', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const matchAllSpy = vi.spyOn(String.prototype, 'matchAll')
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking: vi.fn()
    })

    expect(detector.observe(`${'Coded shell output\r\n'.repeat(10_000)}`)).toBe(false)

    expect(maxStringContextLength(replaceSpy.mock.contexts)).toBeLessThan(10_000)
    expect(maxStringContextLength(matchAllSpy.mock.contexts)).toBe(0)
  })
})

function maxStringContextLength(contexts: unknown[]): number {
  return Math.max(
    0,
    ...contexts.map((context) => (typeof context === 'string' ? context.length : 0))
  )
}
