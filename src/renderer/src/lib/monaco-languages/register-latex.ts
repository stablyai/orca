import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const LATEX_LANGUAGE_ID = 'latex'

export const latexLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '%'
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '`', close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' }
  ]
}

// Why: Full VS Code LaTeX TextMate grammars pull dozens of embedded language
// scopes (python, julia, …). A presentation-only Monarch tokenizer covers
// comments, commands, environments, and math delimiters without that graph.
export const latexMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.latex',
  ignoreCase: false,

  tokenizer: {
    root: [
      { include: '@whitespace' },
      // Line comments
      [/%.*$/, 'comment'],
      // Display / inline math environments
      [/\\\[/, 'string', '@displayMathBracket'],
      [/\\\(/, 'string', '@inlineMathParen'],
      [/\$\$/, 'string', '@displayMathDollar'],
      [/\$/, 'string', '@inlineMathDollar'],
      // \begin{env} / \end{env}
      [
        /\\(begin|end)\s*\{[a-zA-Z*]+\}/,
        {
          cases: {
            '@default': 'keyword'
          }
        }
      ],
      // Commands: \command, \command*, \\, and special single-char commands
      [/\\(?:[a-zA-Z]+|[^a-zA-Z\s])/, 'keyword'],
      // Grouping braces / optional args
      [/[{}]/, '@brackets'],
      [/[[\]]/, '@brackets'],
      // Plain text
      [/[^\\%$[\]{}]+/, '']
    ],

    whitespace: [[/[ \t\r\n]+/, 'white']],

    displayMathBracket: [
      [/\\\]/, 'string', '@pop'],
      [/%.*$/, 'comment'],
      [/\\(?:[a-zA-Z]+|[^a-zA-Z\s])/, 'keyword'],
      [/[^\\%\]]+/, 'string'],
      [/./, 'string']
    ],

    inlineMathParen: [
      [/\\\)/, 'string', '@pop'],
      [/%.*$/, 'comment'],
      [/\\(?:[a-zA-Z]+|[^a-zA-Z\s])/, 'keyword'],
      [/[^\\%)]+/, 'string'],
      [/./, 'string']
    ],

    displayMathDollar: [
      [/\$\$/, 'string', '@pop'],
      [/%.*$/, 'comment'],
      [/\\(?:[a-zA-Z]+|[^a-zA-Z\s])/, 'keyword'],
      [/[^\\%$]+/, 'string'],
      [/./, 'string']
    ],

    inlineMathDollar: [
      [/\$/, 'string', '@pop'],
      [/%.*$/, 'comment'],
      [/\\(?:[a-zA-Z]+|[^a-zA-Z\s])/, 'keyword'],
      [/[^\\%$]+/, 'string'],
      [/./, 'string']
    ]
  }
}

export function registerLatexLanguage(monaco: MonacoModule): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === LATEX_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: LATEX_LANGUAGE_ID,
    extensions: ['.tex', '.ltx', '.latex', '.sty', '.cls'],
    aliases: ['LaTeX', 'latex', 'TeX', 'tex']
  })
  monaco.languages.setLanguageConfiguration(LATEX_LANGUAGE_ID, latexLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, latexMonarchLanguage)
}
