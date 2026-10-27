import type * as Monaco from 'monaco-editor'
import {
  restOfLineWithinEmbedBudget,
  tagCloseWithinEmbedBudget
} from './monarch-embed-entry-budget'

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
      [
        tagCloseWithinEmbedBudget,
        { token: 'tag', switchTo: '@templateBody', nextEmbedded: 'html' }
      ],
      [/>/, { token: 'tag', switchTo: '@templateBodyPlain' }],
      { include: '@tagAttributes' }
    ],
    // Template body always owns HTML; re-enter via templateBodyReenter and keep switchTo transitions flat so </template> returns to root.
    templateBody: [
      [
        /\{\{/,
        { token: 'delimiter.curly', switchTo: '@templateExpressionEnter', nextEmbedded: '@pop' }
      ],
      [/<\/template\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]
    ],
    // Zero-width reentry requires @rematch or Monarch drops the pending HTML embed needed by template-body pop rules.
    templateBodyReenter: [
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@templateBody', nextEmbedded: 'html' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@templateBodyPlain' }]
    ],
    // Over-budget bodies keep structure without touching embeds, bounding recursion for the rest of the line.
    templateBodyPlain: [
      [/\{\{/, { token: 'delimiter.curly', switchTo: '@templateExpressionEnter' }],
      [/<\/template\s*>/, { token: 'tag', next: '@pop' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@templateBody', nextEmbedded: 'html' }
      ],
      [/<\/?[A-Za-z][^>]*>/, 'tag'],
      [/[^<{]+/, ''],
      [/./, '']
    ],
    templateExpressionEnter: [
      [/\}\}/, { token: 'delimiter.curly', switchTo: '@templateBodyReenter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@templateExpression', nextEmbedded: 'typescript' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@templateExpressionPlain' }]
    ],
    templateExpression: [
      [/\}\}/, { token: 'delimiter.curly', switchTo: '@templateBodyReenter', nextEmbedded: '@pop' }]
    ],
    // Same expression, no typescript embed: reached only past the budget.
    templateExpressionPlain: [
      [/\}\}/, { token: 'delimiter.curly', switchTo: '@templateBodyReenter' }],
      [/[^}]+/, ''],
      [/./, '']
    ],
    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [
        tagCloseWithinEmbedBudget,
        { token: 'tag', switchTo: '@scriptBody.$S2', nextEmbedded: '$S2' }
      ],
      [/>/, { token: 'tag', switchTo: '@scriptBodyPlain.$S2' }],
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
    // Re-enter $S2 when the remaining line fits so long openers cannot leave whole blocks unhighlighted.
    scriptBodyPlain: [
      [/<\/script\s*>/, { token: 'tag', next: '@pop' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@scriptBody.$S2', nextEmbedded: '$S2' }
      ],
      [/[^<]+/, ''],
      [/./, '']
    ],
    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [
        tagCloseWithinEmbedBudget,
        { token: 'tag', switchTo: '@styleBody.$S2', nextEmbedded: '$S2' }
      ],
      [/>/, { token: 'tag', switchTo: '@styleBodyPlain.$S2' }],
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
    styleBodyPlain: [
      [/<\/style\s*>/, { token: 'tag', next: '@pop' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@styleBody.$S2', nextEmbedded: '$S2' }
      ],
      [/[^<]+/, ''],
      [/./, '']
    ],
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
