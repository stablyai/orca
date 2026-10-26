import type * as Monaco from 'monaco-editor'
import {
  restOfLineWithinEmbedBudget,
  tagCloseWithinEmbedBudget
} from './monarch-embed-entry-budget'

type MonacoModule = typeof Monaco

export const svelteMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.svelte',
  ignoreCase: true,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '<', close: '>', token: 'delimiter.angle' }
  ],
  tokenizer: {
    // File-start state has no embed to pop; enter HTML before markup and always return through markupReenter.
    root: [
      [/<script(?=\s|>)/, { token: 'tag', switchTo: '@scriptOpen.typescript' }],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css' }],
      [/<!--/, { token: 'comment', switchTo: '@comment' }],
      [/\{\s*\/(if|each|await|key|snippet)\s*\}/, 'keyword.control'],
      [
        /\{\s*#(if|each|await|key|snippet)\b/,
        { token: 'keyword.control', switchTo: '@svelteBlockExpressionEnter' }
      ],
      [
        /\{\s*:(else|then|catch)\b/,
        { token: 'keyword.control', switchTo: '@svelteBlockExpressionEnter' }
      ],
      [
        /\{\s*@(html|debug|const|render)\b/,
        { token: 'keyword.control', switchTo: '@svelteExpressionEnter' }
      ],
      [/\{(?=[^#:/@])/, { token: 'delimiter.curly', switchTo: '@svelteExpressionEnter' }],
      // Use @rematch for zero-width transitions or Monarch drops nextEmbedded, leaving markup without the HTML its pop rules require.
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }
      ],
      // Over-budget structure omits embeds so the rest of the line cannot deepen recursion.
      [/<\/?[A-Za-z][^>]*>/, 'tag'],
      [/[^<{]+/, ''],
      [/./, '']
    ],
    // Markup always owns HTML; parent pop rules handle exits before rematching. Use switchTo for flat state transitions or repeated reentry reaches Monarch maxStack.
    markup: [
      [
        /<script(?=\s|>)/,
        { token: 'tag', switchTo: '@scriptOpen.typescript', nextEmbedded: '@pop' }
      ],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css', nextEmbedded: '@pop' }],
      [/<!--/, { token: 'comment', switchTo: '@comment', nextEmbedded: '@pop' }],
      // Only pop rules can interrupt the active HTML embed for a Svelte closer.
      [
        /\{\s*\/(if|each|await|key|snippet)\s*\}/,
        { token: 'keyword.control', switchTo: '@markupReenter', nextEmbedded: '@pop' }
      ],
      [
        /\{\s*#(if|each|await|key|snippet)\b/,
        { token: 'keyword.control', switchTo: '@svelteBlockExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{\s*:(else|then|catch)\b/,
        { token: 'keyword.control', switchTo: '@svelteBlockExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{\s*@(html|debug|const|render)\b/,
        { token: 'keyword.control', switchTo: '@svelteExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{(?=[^#:/@])/,
        { token: 'delimiter.curly', switchTo: '@svelteExpressionEnter', nextEmbedded: '@pop' }
      ]
    ],
    // Reentry pushes HTML through zero-width @rematch; any other token would fail Monarch’s progress check.
    markupReenter: [
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }
      ],
      // Over budget: `root` carries the same structural rules without embeds.
      [/(?=.)/, { token: '@rematch', switchTo: '@root' }]
    ],
    comment: [
      [/-->/, { token: 'comment', switchTo: '@markupReenter' }],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    // An active embed exposes only exit rules, preventing brace counting; nested expressions close at the first inner } (known regex-grammar limit).
    svelteExpressionEnter: [
      // Empty expressions push no TypeScript; unwind only state.
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@svelteExpression', nextEmbedded: 'typescript' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@svelteExpressionPlain' }]
    ],
    svelteExpression: [
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    // Same expression, no typescript embed: reached only past the budget.
    svelteExpressionPlain: [
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter' }],
      [/[^}]+/, '']
    ],
    svelteBlockExpressionEnter: [
      [/\}/, { token: 'keyword.control', switchTo: '@markupReenter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@svelteBlockExpression', nextEmbedded: 'typescript' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@svelteBlockExpressionPlain' }]
    ],
    svelteBlockExpression: [
      [/\}/, { token: 'keyword.control', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    svelteBlockExpressionPlain: [
      [/\}/, { token: 'keyword.control', switchTo: '@markupReenter' }],
      [/[^}]+/, '']
    ],
    scriptOpen: [
      // Self-closing scripts push no embed but may pop markup’s HTML on entry; re-enter uniformly.
      [/\/>/, { token: 'tag', switchTo: '@markupReenter' }],
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
    scriptBody: [
      [/<\/script\s*>/, { token: 'tag', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    // Re-enter $S2 once the remaining line fits so long openers cannot leave the entire block unhighlighted.
    scriptBodyPlain: [
      [/<\/script\s*>/, { token: 'tag', switchTo: '@markupReenter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@scriptBody.$S2', nextEmbedded: '$S2' }
      ],
      [/[^<]+/, ''],
      [/./, '']
    ],
    styleOpen: [
      [/\/>/, { token: 'tag', switchTo: '@markupReenter' }],
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
    styleBody: [
      [/<\/style\s*>/, { token: 'tag', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    styleBodyPlain: [
      [/<\/style\s*>/, { token: 'tag', switchTo: '@markupReenter' }],
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

export const svelteLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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

export function registerSvelteLanguage(monaco: MonacoModule): void {
  const svelteAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'svelte')
  if (svelteAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'svelte',
    extensions: ['.svelte'],
    aliases: ['Svelte']
  })
  monaco.languages.setMonarchTokensProvider('svelte', svelteMonarchLanguage)
  monaco.languages.setLanguageConfiguration('svelte', svelteLanguageConfiguration)
}
