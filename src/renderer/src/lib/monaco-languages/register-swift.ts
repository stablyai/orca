import type * as Monaco from 'monaco-editor'

type MonarchLanguage = Monaco.languages.IMonarchLanguage

function withSwiftRawStrings(language: MonarchLanguage): MonarchLanguage {
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      literal: [
        // $S2 = pounds, $S3 = quotes. #""" opens multiline only before a blank tail (swiftc's
        // same-line-close check differs only on invalid code and would rescan the line per opener).
        // Why no upper bound: the closer must repeat the opener's exact count, so capping it at 16
        // read a 17-sign opener's first sign as an operator and closed on the wrong quote (#47295).
        [/(#+)("""(?=\s*$))/, { token: 'string.quote', next: '@rawstring.$1.$2' }],
        [/(#+)(")/, { token: 'string.quote', next: '@rawline.$1.$2' }],
        // Without this rule a failed opener retries `#+` at every sign of the run, which is
        // quadratic (#46951). The lookahead is inert under this order; it only guards a reorder.
        [/#+(?![#"])/, 'operator'],
        ...language.tokenizer.literal
      ],
      // A single-line raw string ends at the line break even when unterminated.
      rawline: [[/^/, { token: '', next: '@pop' }], { include: '@rawstring' }],
      rawstring: [
        [/\\$S2\(/, { token: 'operator', next: '@interpolatedexpression' }],
        [/\\$S2./, 'string'],
        [/$S3$S2/, { token: 'string.quote', next: '@pop' }],
        [/[^"\\]+/, 'string'],
        [/./, 'string']
      ]
    }
  }
}

export function registerSwiftLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  // A later factory replaces the one Monaco's own Swift contribution registered.
  monaco.languages.registerTokensProviderFactory('swift', {
    create: async () => {
      const { language } = await import('monaco-editor/esm/vs/basic-languages/swift/swift.js')
      return withSwiftRawStrings(language)
    }
  })
}
