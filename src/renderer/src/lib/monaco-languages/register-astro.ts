import type * as Monaco from 'monaco-editor'
import {
  restOfLineWithinEmbedBudget,
  tagCloseWithinEmbedBudget
} from './monarch-embed-entry-budget'

type MonacoModule = typeof Monaco

export const astroMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.astro',
  ignoreCase: true,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '<', close: '>', token: 'delimiter.angle' }
  ],
  tokenizer: {
    // Initial state has no embed to pop; route non-frontmatter through markupReenter to establish HTML ownership once.
    root: [
      // Only file-start --- opens TypeScript frontmatter.
      [/---\s*$/, { token: 'keyword', switchTo: '@frontmatter', nextEmbedded: 'typescript' }],
      [/(?=.)/, { token: '@rematch', switchTo: '@markupReenter' }]
    ],
    // Pop only a standalone column-zero fence. Monaco’s ^ anchors the embed region, safe here because entry is at end-of-line; never reuse this for mid-line entry (#1127).
    frontmatter: [
      [/^---\s*$/, { token: 'keyword', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    // Markup always owns an HTML embed; return via markupReenter after each plain-JS expression.
    markup: [
      [
        /<script(?=\s|>)/,
        { token: 'tag', switchTo: '@scriptOpen.javascript', nextEmbedded: '@pop' }
      ],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css', nextEmbedded: '@pop' }],
      [/<!--/, { token: 'comment', switchTo: '@comment', nextEmbedded: '@pop' }],
      [/\{/, { token: 'delimiter.curly', switchTo: '@astroExpressionEnter', nextEmbedded: '@pop' }]
    ],
    // Zero-width transitions require @rematch or Monarch silently drops nextEmbedded and leaves markup without HTML.
    markupReenter: [
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@markupPlain' }]
    ],
    // Keep over-budget structure without embeds to stop recursion; retry HTML on the next line when its remainder fits.
    markupPlain: [
      [/<script(?=\s|>)/, { token: 'tag', switchTo: '@scriptOpen.javascript' }],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css' }],
      [/<!--/, { token: 'comment', switchTo: '@comment' }],
      [/\{/, { token: 'delimiter.curly', switchTo: '@astroExpressionEnter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }
      ],
      [/<\/?[A-Za-z][^>]*>/, 'tag'],
      [/[^<{]+/, ''],
      [/./, '']
    ],
    comment: [
      [/-->/, { token: 'comment', switchTo: '@markupReenter' }],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    // Active embeds expose only parent exit rules, so brace counting cannot run; nested JS braces close at the first }, a known regex-grammar limit.
    astroExpressionEnter: [
      // Empty `{}`: entry popped html, but typescript was never entered.
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter' }],
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@astroExpression', nextEmbedded: 'typescript' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@astroExpressionPlain' }]
    ],
    astroExpression: [
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    // Same expression, no typescript embed: reached only past the budget.
    astroExpressionPlain: [
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter' }],
      [/[^}]+/, '']
    ],
    scriptOpen: [
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
    // Re-enter $S2 as soon as the remaining line fits so long opening lines cannot leave entire blocks unhighlighted.
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

export const astroLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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

export function registerAstroLanguage(monaco: MonacoModule): void {
  const astroAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'astro')
  if (astroAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'astro',
    extensions: ['.astro'],
    aliases: ['Astro']
  })
  monaco.languages.setMonarchTokensProvider('astro', astroMonarchLanguage)
  monaco.languages.setLanguageConfiguration('astro', astroLanguageConfiguration)
}
