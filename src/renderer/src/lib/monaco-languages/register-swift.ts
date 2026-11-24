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
        [/(#{1,16})("""(?=\s*$))/, { token: 'string.quote', next: '@rawstring.$1.$2' }],
        [/(#{1,16})(")/, { token: 'string.quote', next: '@rawline.$1.$2' }],
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
