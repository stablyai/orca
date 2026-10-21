import type * as Monaco from 'monaco-editor'

type HttpMonaco = {
  languages: Pick<
    typeof Monaco.languages,
    'getLanguages' | 'register' | 'setLanguageConfiguration' | 'setMonarchTokensProvider'
  >
}

export const HTTP_LANGUAGE_ID = 'http'

export const httpLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#'
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
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ]
}

const REQUEST_METHOD = /^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(?=\s)/

// Covers the REST Client (VS Code) and JetBrains HTTP Client dialects of .http/.rest files.
export const httpMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.http',

  tokenizer: {
    root: [
      { include: '@requestBoundary' },
      { include: '@comments' },
      [/^(\s*)(@[\w.-]+)(\s*=)/, ['', 'variable', { token: 'delimiter', next: '@variableValue' }]],
      [/^(\s*)(import|run)(\s+)(\S.*)$/, ['', 'keyword', '', 'string']],
      [REQUEST_METHOD, { token: 'keyword', switchTo: '@requestTarget' }],
      [/^(?=\s*(?:https?:\/\/|\{\{))/, { token: '@rematch', switchTo: '@requestTarget' }]
    ],

    // A request ends at the next `###`; JetBrains `< {% %}` / `> {% %}` scripts embed JavaScript.
    requestBoundary: [
      [/^\s*###.*$/, { token: 'type', switchTo: '@root' }],
      [
        /^(\s*)([<>])(\s*)(\{%)/,
        ['', 'keyword', '', { token: 'delimiter', switchTo: '@script', nextEmbedded: 'javascript' }]
      ],
      [/^(\s*)(<>|>>!?|>)(\s+)(\S.*)$/, ['', 'keyword', '', 'string']]
    ],

    comments: [
      [/^(\s*(?:#|\/\/)\s*)(@[\w-]+)(.*)$/, ['comment', 'annotation', 'comment']],
      [/^\s*(?:#|\/\/).*$/, 'comment']
    ],

    // Only exit rules run while the JavaScript embed is active.
    script: [
      [/%\}/, { token: 'delimiter', switchTo: '@root', nextEmbedded: '@pop' }],
      [/^\s*###.*$/, { token: 'type', switchTo: '@root', nextEmbedded: '@pop' }]
    ],

    variableValue: [
      [/^/, { token: '@rematch', next: '@pop' }],
      { include: '@variables' },
      [/[^{]+/, 'string'],
      [/\{/, 'string']
    ],

    requestTarget: [
      { include: '@requestBoundary' },
      { include: '@comments' },
      [/^(\s+)([?&])/, ['', 'delimiter']],
      [/^(?=\s*\S)/, { token: '@rematch', switchTo: '@headers' }],
      { include: '@variables' },
      [/HTTP\/[\d.]+/, 'keyword'],
      [/[^\s{]+/, 'string'],
      [/\{/, 'string']
    ],

    headers: [
      { include: '@requestBoundary' },
      { include: '@comments' },
      [/^([\w!#$%&'*+.^`|~-]+)(\s*:)/, ['attribute.name', 'delimiter']],
      [/^(?=\s*\S)/, { token: '@rematch', switchTo: '@body' }],
      { include: '@variables' },
      [/[^{]+/, 'attribute.value'],
      [/\{/, 'attribute.value']
    ],

    body: [
      { include: '@requestBoundary' },
      [/^(\s*)(<)(\s+)(\S.*)$/, ['', 'keyword', '', 'string']],
      { include: '@variables' },
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'attribute.name'],
      // Only enter the string state when the closing quote is on this line.
      [/"(?=(?:[^"\\]|\\.)*")/, 'string', '@string'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[A-Za-z_][\w.-]*/, ''],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[:,=&]/, 'delimiter']
    ],

    string: [
      { include: '@variables' },
      [/[^"\\{]+/, 'string'],
      [/\\./, 'string.escape'],
      [/\{/, 'string'],
      [/"/, 'string', '@pop']
    ],

    variables: [[/\{\{[^{}]*\}\}/, 'variable']]
  }
}

export function registerHttpLanguage(monaco: HttpMonaco): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === HTTP_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: HTTP_LANGUAGE_ID,
    extensions: ['.http', '.rest'],
    aliases: ['HTTP', 'http', 'REST Client']
  })
  monaco.languages.setLanguageConfiguration(HTTP_LANGUAGE_ID, httpLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(HTTP_LANGUAGE_ID, httpMonarchLanguage)
}
