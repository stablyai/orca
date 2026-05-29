import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const batchMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.batch',
  ignoreCase: true,
  brackets: [
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '[', close: ']', token: 'delimiter.square' }
  ],
  keywords: [
    '@echo',
    'assoc',
    'break',
    'call',
    'cd',
    'chcp',
    'choice',
    'cls',
    'color',
    'copy',
    'date',
    'del',
    'dir',
    'do',
    'echo',
    'else',
    'endlocal',
    'erase',
    'exit',
    'find',
    'findstr',
    'for',
    'goto',
    'if',
    'in',
    'md',
    'mkdir',
    'mode',
    'move',
    'not',
    'pause',
    'popd',
    'pushd',
    'rd',
    'rem',
    'ren',
    'rename',
    'rmdir',
    'set',
    'setlocal',
    'shift',
    'start',
    'time',
    'timeout',
    'title',
    'type',
    'ver',
    'verify',
    'vol',
    'where'
  ],
  tokenizer: {
    root: [
      [/^\s*@?[rR][eE][mM]\b.*$/, 'comment'],
      [/^\s*::.*$/, 'comment'],
      [/^\s*:[^:\s][^\s&|<>]*/, 'type.identifier'],
      [/"(?:\^.|[^"^])*"/, 'string'],
      [/%~[fdpnxsatzFDPNXSATZ]*[0-9A-Za-z]/, 'variable.predefined'],
      [/%[A-Za-z_][\w]*%/, 'variable'],
      [/![A-Za-z_][\w]*!/, 'variable'],
      [/%%[A-Za-z]/, 'variable'],
      [/%[0-9*]/, 'variable.predefined'],
      [/\^[\^|&<>]/, 'string.escape'],
      [/(?:>>|&&|\|\||[<>|&=])/, 'operator'],
      [/[()[\]]/, '@brackets'],
      [/\b(?:equ|neq|lss|leq|gtr|geq|defined|exist|errorlevel)\b/, 'operator'],
      [/@?[A-Za-z][\w.-]*/, { cases: { '@keywords': 'keyword', '@default': '' } }],
      [/(?:\/|-)[A-Za-z][\w-]*/, 'attribute.name'],
      [/\d+/, 'number'],
      [/\s+/, 'white']
    ]
  }
}

export const batchLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: 'rem ' },
  brackets: [
    ['(', ')'],
    ['[', ']']
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ]
}

export function registerBatchLanguage(monaco: MonacoModule): void {
  const batchAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'batch')
  if (batchAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'batch',
    extensions: ['.bat', '.cmd'],
    aliases: ['Batch', 'Windows Batch']
  })
  monaco.languages.setMonarchTokensProvider('batch', batchMonarchLanguage)
  monaco.languages.setLanguageConfiguration('batch', batchLanguageConfiguration)
}
