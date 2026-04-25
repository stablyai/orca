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
      [/<script(?=\s|>)/, 'tag', '@scriptOpen.typescript'],
      [/<style(?=\s|>)/, 'tag', '@styleOpen.css'],
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
      [/>/, { token: 'tag', switchTo: '@templateBody', nextEmbedded: 'html' }],
      { include: '@tagAttributes' }
    ],
    templateBody: [
      [
        /\{\{/,
        { token: 'delimiter.curly', next: '@templateExpressionEnter', nextEmbedded: '@pop' }
      ],
      [/<\/template\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }],
      // After a `{{ ... }}` interpolation returns here, the html embed
      // has been popped alongside the typescript expression embed. Re-enter
      // html so the remaining template markup is tokenized by Monaco's html
      // tokenizer instead of falling back to the empty default token.
      [/(?=.)/, { token: '', nextEmbedded: 'html' }]
    ],
    templateExpressionEnter: [
      [/\}\}/, { token: 'delimiter.curly', next: '@pop' }],
      [/(?=.)/, { token: '', switchTo: '@templateExpression', nextEmbedded: 'typescript' }]
    ],
    templateExpression: [
      [/\}\}/, { token: 'delimiter.curly', next: '@pop', nextEmbedded: '@pop' }]
    ],
    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@scriptBody.$S2', nextEmbedded: '$S2' }],
      [/lang(?=\s*=)/, { token: 'attribute.name', switchTo: '@scriptLangBeforeEquals.$S2' }],
      { include: '@tagAttributes' }
    ],
    scriptLangBeforeEquals: [
      [/=/, { token: 'delimiter', switchTo: '@scriptLangValue.$S2' }],
      [/\s+/, 'white'],
      [/(?=.)/, { token: '', switchTo: '@scriptOpen.$S2' }]
    ],
    scriptLangValue: [
      [/"(?:js|javascript)"/, { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }],
      [/'(?:js|javascript)'/, { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }],
      [
        /(?:js|javascript)(?=\s|\/|>|$)/,
        { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }
      ],
      [/"(?:ts|typescript)"/, { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }],
      [/'(?:ts|typescript)'/, { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }],
      [
        /(?:ts|typescript)(?=\s|\/|>|$)/,
        { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }
      ],
      [/[^\s/>]+/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/"[^"]*"/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/'[^']*'/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/\s+/, 'white']
    ],
    scriptBody: [[/<\/script\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@styleBody.$S2', nextEmbedded: '$S2' }],
      [/lang(?=\s*=)/, { token: 'attribute.name', switchTo: '@styleLangBeforeEquals.$S2' }],
      { include: '@tagAttributes' }
    ],
    styleLangBeforeEquals: [
      [/=/, { token: 'delimiter', switchTo: '@styleLangValue.$S2' }],
      [/\s+/, 'white'],
      [/(?=.)/, { token: '', switchTo: '@styleOpen.$S2' }]
    ],
    styleLangValue: [
      [/"scss"/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/'scss'/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/scss(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/"sass"/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/'sass'/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/sass(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/"less"/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/'less'/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/less(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/"css"/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/'css'/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/css(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/[^\s/>]+/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/"[^"]*"/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/'[^']*'/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/\s+/, 'white']
    ],
    styleBody: [[/<\/style\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
    tagAttributes: [
      [/[^\s/>=]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white']
    ]
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
