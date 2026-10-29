// One report must name one folder in both OSC 7 parsers: the daemon's (checkpoints, restores) reads
// raw PTY bytes; the renderer's (split, new terminal) reads what xterm's OSC parser hands it. Each
// side's tests run these cases, including what nushell sends raw.
/** No report reached the parser, or it was refused: the pane keeps the folder it had. */
export const OSC7_KEEPS_FOLDER = 'keeps-folder'

export type Osc7AgreementCase = {
  name: string
  /** The report as the shell writes it, between `ESC ]7;` and BEL. */
  uri: string
  /** What both parsers name for this payload, or null when they refuse it. */
  folder: string | null
  /**
   * Known renderer gap: xterm's OSC parser drops raw C0 bytes, ends the sequence at a raw ESC and
   * cancels it at CAN or SUB, before the renderer sees the payload.
   */
  viaXterm?: string | null
  /** xterm cancels the sequence (CAN, SUB), so the renderer's OSC 7 handler never runs. */
  xtermCancels?: true
  /**
   * The daemon's PTY scanner, when it differs from `folder`: a raw ESC that is not ST invalidates
   * the report.
   */
  viaScanner?: typeof OSC7_KEEPS_FOLDER
}

export const OSC7_PARSER_AGREEMENT_CASES: readonly Osc7AgreementCase[] = [
  { name: 'a raw tab', uri: 'file://Desktop/tmp/a\tb', folder: '/tmp/a\tb', viaXterm: '/tmp/ab' },
  {
    name: 'a raw newline',
    uri: 'file://Desktop/tmp/a\nb',
    folder: '/tmp/a\nb',
    viaXterm: '/tmp/ab'
  },
  {
    name: 'a raw carriage return',
    uri: 'file://Desktop/tmp/a\rb',
    folder: '/tmp/a\rb',
    viaXterm: '/tmp/ab'
  },
  { name: 'a trailing space', uri: 'file://Desktop/tmp/a ', folder: '/tmp/a ' },
  { name: 'a space inside', uri: 'file://Desktop/tmp/a b', folder: '/tmp/a b' },
  { name: 'a lone %', uri: 'file://Desktop/tmp/100%', folder: '/tmp/100%' },
  { name: 'a # and ?', uri: 'file://Desktop/tmp/h#a?b', folder: '/tmp/h#a?b' },
  { name: 'an encoded newline', uri: 'file:///tmp/a%0Ab', folder: '/tmp/a\nb' },
  { name: 'a leading raw NUL', uri: 'file:///\u0000tmp', folder: null, viaXterm: '/tmp' },
  { name: 'a trailing raw NUL', uri: 'file:///tmp/a\u0000', folder: null, viaXterm: '/tmp/a' },
  { name: 'an encoded NUL', uri: 'file:///tmp/%00', folder: null },
  { name: 'non-UTF-8 hex', uri: 'file:///tmp/%FF', folder: null },
  {
    name: 'a raw ESC',
    uri: 'file:///tmp/a\u001bb',
    folder: '/tmp/a\u001bb',
    viaXterm: '/tmp/a',
    viaScanner: OSC7_KEEPS_FOLDER
  },
  {
    name: 'a raw CAN',
    uri: 'file:///tmp/a\u0018b',
    folder: '/tmp/a\u0018b',
    xtermCancels: true
  },
  {
    name: 'a raw SUB',
    uri: 'file:///tmp/a\u001ab',
    folder: '/tmp/a\u001ab',
    xtermCancels: true
  }
]
