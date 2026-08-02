import type * as Monaco from 'monaco-editor'
import { VHDL_PREDEFINED_TYPES, VHDL_RESERVED_WORDS } from './vhdl-reserved-words'

type MonacoModule = typeof Monaco

export const VHDL_LANGUAGE_ID = 'vhdl'

export const vhdlLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '--',
    // Block comments are VHDL-2008 and do not nest.
    blockComment: ['/*', '*/']
  },
  // VHDL groups only with parentheses; `begin`/`end` is not a balanced pair
  // (an architecture opens with `is` and closes the same `end`).
  brackets: [['(', ')']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] }
  ],
  // No auto-closing apostrophe: it is the attribute tick (clk'event) more often
  // than a character delimiter, so closing it on every keystroke fights typing.
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export const vhdlMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.vhdl',
  // Applies to the rule regexes AND the keyword lookups below.
  ignoreCase: true,

  brackets: [{ token: 'delimiter.parenthesis', open: '(', close: ')' }],

  keywords: VHDL_RESERVED_WORDS,
  typeKeywords: VHDL_PREDEFINED_TYPES,

  // `-` only outside a `--` pair, so `q <=-- note` still starts a comment.
  symbols: /(?:[=><!~?:&|+*/^%]|-(?!-))+/,

  tokenizer: {
    root: [
      { include: '@whitespace' },
      { include: '@bitStrings' },

      // Reached only in value position, where an apostrophe can only open a
      // character literal — so '(' and ''' stay literals. See @afterName.
      [/'.'/, 'string'],

      // Extended identifier: \any Text, Spaced Or Reserved\
      [/\\[^\\]*\\/, 'identifier', '@afterName'],

      [
        /[a-z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': { token: 'type', next: '@afterName' },
            '@default': { token: 'identifier', next: '@afterName' }
          }
        }
      ],

      { include: '@numbers' },

      [/\(/, '@brackets'],
      [/\)/, { token: '@brackets', next: '@afterName' }],
      [/@symbols/, 'delimiter'],
      [/[;,.]/, 'delimiter'],

      // A VHDL string cannot span lines, so consume an unterminated one here —
      // otherwise @string would bleed over the rest of the file.
      [/"(?:[^"]|"")*$/, 'string.invalid'],
      [/"/, 'string', '@string']
    ],

    // Why: the apostrophe is both the attribute tick and a character-literal
    // delimiter, and Monarch matches forward from the cursor with no lookbehind,
    // so "did a name just end?" has to be carried in the state.
    afterName: [
      // Qualified expression: std_logic_vector'(others => '0')
      [/'(?=\()/, 'delimiter', '@pop'],
      // Attribute, staying put so chains like integer'base'high keep matching.
      [/'[a-z_]\w*/, 'type'],
      [/(?=.)/, { token: '@rematch', next: '@pop' }]
    ],

    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment']
    ],

    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/\*/, 'comment']
    ],

    // Bit-string literals, including the VHDL-2008 sized and signed forms
    // (8x"FF", 10sb"1010"). Ahead of identifiers so the base character is not
    // consumed as a one-letter name. The digit sets carry the std_logic
    // meta-values too — x"ZZZZ" and b"UU10" are everyday RTL.
    bitStrings: [
      [/(?:\d[\d_]*)?[us]?b"[01zxuwlh_-]*"/, 'number.binary'],
      [/(?:\d[\d_]*)?[us]?o"[0-7zxuwlh_-]*"/, 'number.octal'],
      [/(?:\d[\d_]*)?[us]?x"[0-9a-fzxuwlh_-]*"/, 'number.hex'],
      // Decimal takes no u/s prefix and no meta-values.
      [/(?:\d[\d_]*)?d"[\d_]*"/, 'number']
    ],

    numbers: [
      // Based literal: 16#FFEE#, 2#1010_1010#, 16#F.FF#E+2
      [/\d[\d_]*#[0-9a-f_]+(?:\.[0-9a-f_]+)?#(?:e[+-]?\d[\d_]*)?/, 'number.hex'],
      [/\d[\d_]*\.\d[\d_]*(?:e[+-]?\d[\d_]*)?/, 'number.float'],
      [/\d[\d_]*(?:e[+-]?\d[\d_]*)?/, 'number']
    ],

    string: [
      [/[^"]+/, 'string'],
      // A quote is embedded by doubling it; VHDL has no backslash escapes.
      [/""/, 'string.escape'],
      [/"/, 'string', '@pop']
    ]
  }
}

export function registerVhdlLanguage(monaco: MonacoModule): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === VHDL_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: VHDL_LANGUAGE_ID,
    extensions: ['.vhd', '.vhdl', '.vhf', '.vhi', '.vho', '.vhs', '.vht', '.vhw'],
    aliases: ['VHDL', 'vhdl']
  })
  monaco.languages.setLanguageConfiguration(VHDL_LANGUAGE_ID, vhdlLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(VHDL_LANGUAGE_ID, vhdlMonarchLanguage)
}
