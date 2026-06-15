import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const nimMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.nim',
  keywords: [
    'addr',
    'and',
    'as',
    'asm',
    'bind',
    'block',
    'break',
    'case',
    'cast',
    'concept',
    'const',
    'continue',
    'converter',
    'defer',
    'discard',
    'distinct',
    'div',
    'do',
    'elif',
    'else',
    'end',
    'enum',
    'except',
    'export',
    'finally',
    'for',
    'from',
    'func',
    'if',
    'import',
    'in',
    'include',
    'interface',
    'is',
    'isnot',
    'iterator',
    'let',
    'macro',
    'method',
    'mixin',
    'mod',
    'nil',
    'not',
    'notin',
    'object',
    'of',
    'or',
    'out',
    'proc',
    'ptr',
    'raise',
    'ref',
    'return',
    'shl',
    'shr',
    'static',
    'template',
    'try',
    'tuple',
    'type',
    'using',
    'var',
    'when',
    'while',
    'xor',
    'yield'
  ],
  typeKeywords: [
    'bool',
    'char',
    'cstring',
    'float',
    'float32',
    'float64',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'pointer',
    'seq',
    'string',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64'
  ],
  operators: [
    '=',
    '>',
    '<',
    '!',
    '~',
    '?',
    ':',
    '==',
    '<=',
    '>=',
    '!=',
    '+',
    '-',
    '*',
    '/',
    '&',
    '|',
    '^',
    '%',
    '+=',
    '-=',
    '*=',
    '/=',
    '&=',
    '|=',
    '^=',
    '%=',
    '..'
  ],
  symbols: /[=><!~?:+\-*/&|^%]+/,
  escapes: /\\(?:[abefnrtv\\"']|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' }
  ],
  tokenizer: {
    root: [
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@typeKeywords': 'type.identifier',
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }
      ],
      { include: '@whitespace' },
      [/[{}()[\]]/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/, 'number'],
      [/"/, 'string', '@stringDouble'],
      [/'(?:[^\\']|@escapes)'/, 'string']
    ],
    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/#\[/, 'comment', '@commentBlock'],
      [/#.*$/, 'comment']
    ],
    commentBlock: [
      [/#\]/, 'comment', '@pop'],
      [/#\[/, 'comment', '@push'],
      [/[^#\]]+/, 'comment'],
      [/./, 'comment']
    ],
    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop']
    ]
  }
}

export function registerNimLanguage(monaco: MonacoModule): void {
  if (!monaco.languages.getLanguages().some((item) => item.id === 'nim')) {
    monaco.languages.register({
      id: 'nim',
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    })
  }

  monaco.languages.setLanguageConfiguration('nim', {
    comments: {
      lineComment: '#',
      blockComment: ['#[', ']#']
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
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ]
  })
  monaco.languages.setMonarchTokensProvider('nim', nimMonarchLanguage)
}
