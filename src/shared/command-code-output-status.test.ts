import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCommandCodeOutputStatusDetector,
  stripTerminalControl
} from './command-code-output-status'

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
    expect(detector.observe('# Command Code v0.27.2\r\n')).toBe(false)
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

  it('does not trust near-miss Command Code banner text', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: null,
      onWorking
    })

    expect(detector.observe('NotCommand CodeX\r\n⌘ Parsing...')).toBe(false)

    expect(onWorking).not.toHaveBeenCalled()
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

  it.each([
    '# Command Code v1.2\r\n',
    '# Command Code v1.2.3.4\r\n',
    '# Command Code v01.2.3\r\n',
    '# Command Code v1.2.3suffix\r\n',
    '#\nCommand Code v1.2.3\r\n'
  ])('does not arm for noncanonical banner %j', (banner) => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({ startupCommand: null, onWorking })

    expect(detector.observe(banner)).toBe(false)
    expect(detector.observe('✻ Thinking...')).toBe(false)

    expect(onWorking).not.toHaveBeenCalled()
  })

  it('does not arm from a four-part version split at a PTY chunk boundary', () => {
    const onWorking = vi.fn()
    const detector = createCommandCodeOutputStatusDetector({ startupCommand: null, onWorking })

    expect(detector.observe('# Command Code v1.2.3')).toBe(false)
    expect(detector.observe('.4\r\n')).toBe(false)
    expect(detector.observe('✻ Thinking...')).toBe(false)

    expect(onWorking).not.toHaveBeenCalled()
  })

  it.each(['# Command Code v1.2.3\r\n', '# Command Code v1.2.3-beta.1+build.9\n'])(
    'arms for canonical banner %j',
    (banner) => {
      const onWorking = vi.fn()
      const detector = createCommandCodeOutputStatusDetector({ startupCommand: null, onWorking })

      expect(detector.observe(banner)).toBe(false)
      expect(detector.observe('✻ Thinking...')).toBe(true)

      expect(onWorking).toHaveBeenCalledWith('')
    }
  )

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

describe('terminal control stripping', () => {
  const esc = String.fromCharCode(0x1b)
  const bel = String.fromCharCode(0x07)
  const ansiEscape = new RegExp(
    `${esc}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${bel}]*(?:${bel}|${esc}\\\\))`,
    'g'
  )
  const incompleteAnsiEscape = new RegExp(
    `${esc}(?:\\[[0-?]*[ -/]*|\\][^${bel}${esc}]*|\\S?)?$`,
    'g'
  )

  function legacyStripTerminalControl(data: string): string {
    const withoutAnsi = data.replace(ansiEscape, '').replace(incompleteAnsiEscape, '')
    let output = ''
    for (let index = 0; index < withoutAnsi.length; index += 1) {
      const code = withoutAnsi.charCodeAt(index)
      if ((code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
        continue
      }
      output += withoutAnsi[index]
    }
    return output
  }

  function makeRandom(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x1_0000_0000
    }
  }

  function expectLegacyEquivalent(data: string): void {
    expect(stripTerminalControl(data)).toBe(legacyStripTerminalControl(data))
  }

  function promptFrom(raw: string): string | null {
    let captured: string | null = null
    const detector = createCommandCodeOutputStatusDetector({
      startupCommand: 'command-code',
      onWorking: (prompt) => {
        captured = prompt
      }
    })
    detector.observe(raw)
    return captured
  }

  it('strips control bytes wherever they sit around the prompt text', () => {
    expect(promptFrom('❯ plain prompt\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe('plain prompt')
    expect(promptFrom('\x07❯ leading control\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe(
      'leading control'
    )
    expect(promptFrom('❯ trailing control\x07\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe(
      'trailing control'
    )
    expect(promptFrom('❯ adjacent\x07\x01\x02controls\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe(
      'adjacentcontrols'
    )
  })

  it('preserves multi-byte text and newlines while stripping', () => {
    expect(promptFrom('❯ 日本語 \u{1f389} prompt\r\n\x1b[35m✻ Thinking...\x1b[0m')).toBe(
      '日本語 \u{1f389} prompt'
    )
  })

  it('matches the legacy filter across ANSI, C0/C1, line breaks, and Unicode', () => {
    for (const data of [
      '',
      'plain text',
      '\x1b[35mstyled\x1b[0m',
      '\x1b[unterminated',
      '\x00leading',
      'trailing\x9f',
      '\x01\x02adjacent\x7f\x80',
      'keep\r\nline breaks',
      '日本語 \u{1f389} \ud83d \ude00',
      '\x1b]0;title\x07prompt',
      '\x1b]0;title\x1b\\prompt'
    ]) {
      expectLegacyEquivalent(data)
    }
  })

  it('matches legacy output at density thresholds and block resets', () => {
    const control = '\x01'
    const fixtures = [
      `${control.repeat(31)}${'a'.repeat(33)}`,
      `${control.repeat(32)}${'a'.repeat(32)}`,
      `${'a'.repeat(32)}${control.repeat(31)}a`,
      `${control.repeat(31)}${'a'.repeat(33)}${control.repeat(31)}z`,
      `${control.repeat(31)}${'a'.repeat(33)}${control.repeat(32)}z`,
      `${'a'.repeat(64 * 3)}${control.repeat(32)}tail`,
      `${'a\x01'.repeat(2048)}tail`
    ]
    for (const data of fixtures) {
      expectLegacyEquivalent(data)
    }
  })

  it('exhaustively matches short strings over control and Unicode code units', () => {
    const alphabet = ['a', '\r', '\n', '\x01', '\x7f', '\x80', '\u20ac', '\ud83d']
    for (let encoded = 0; encoded < alphabet.length ** 4; encoded += 1) {
      let cursor = encoded
      let data = ''
      for (let position = 0; position < 4; position += 1) {
        data += alphabet[cursor % alphabet.length]
        cursor = Math.floor(cursor / alphabet.length)
      }
      expectLegacyEquivalent(data)
    }
  })

  it('matches seeded random terminal text', () => {
    const random = makeRandom(0xc0de_0727)
    const alphabet = [
      'a',
      'Z',
      '\r',
      '\n',
      '\x00',
      '\x1f',
      '\x7f',
      '\x9f',
      '\u00e9',
      '\u20ac',
      '\u{1f389}',
      '\x1b[35m',
      '\x1b[0m'
    ]
    for (let trial = 0; trial < 2_000; trial += 1) {
      let data = ''
      const parts = Math.floor(random() * 256)
      for (let index = 0; index < parts; index += 1) {
        data += alphabet[Math.floor(random() * alphabet.length)]
      }
      expectLegacyEquivalent(data)
    }
  })
})
