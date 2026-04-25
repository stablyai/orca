import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const vueMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.vue',
  ignoreCase: true,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '<', close: '>', token: 'delimiter.angle' }
  ],
  tokenizer: {
    root: [
      [/<template(?=\s|>)/, 'tag', '@templateOpen'],
      [/<script(?=\s|>)/, 'tag', '@scriptOpen'],
      [/<style(?=\s|>)/, 'tag', '@styleOpen'],
      [/<!--/, 'comment', '@comment'],
      [/<\/?[A-Za-z][^>]*>/, 'tag'],
      [/[^<]+/, '']
    ],
    comment: [
      [/-->/, 'comment', '@pop'],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    templateOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', next: '@templateBody', nextEmbedded: 'html' }],
      [/[^\s/>=]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white']
    ],
    templateBody: [
      [/\{\{/, { token: 'delimiter.curly', next: '@templateExpression', nextEmbedded: '@pop' }],
      [/<\/template\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]
    ],
    templateExpression: [
      [/\}\}/, { token: 'delimiter.curly', next: '@pop', nextEmbedded: 'html' }],
      [/[^}]+/, 'metatag'],
      [/./, 'metatag']
    ],
    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', next: '@scriptBody', nextEmbedded: 'typescript' }],
      [/[^\s/>=]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white']
    ],
    scriptBody: [[/<\/script\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', next: '@styleBody', nextEmbedded: 'css' }],
      [/[^\s/>=]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white']
    ],
    styleBody: [[/<\/style\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]]
  }
}

export const vueLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['<', '>']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ]
}

export function registerVueLanguage(monaco: MonacoModule): void {
  const vueAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'vue')
  if (vueAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'vue',
    extensions: ['.vue'],
    aliases: ['Vue']
  })
  monaco.languages.setMonarchTokensProvider('vue', vueMonarchLanguage)
  monaco.languages.setLanguageConfiguration('vue', vueLanguageConfiguration)
}
