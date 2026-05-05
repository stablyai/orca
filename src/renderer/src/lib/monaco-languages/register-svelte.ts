import type * as Monaco from 'monaco-editor'

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
    // Entry state: the `start` state runs on the very first token and has no
    // embed on the stack. Structural rules MUST NOT emit `nextEmbedded:
    // '@pop'` from here (Monarch throws "cannot pop embedded language if not
    // inside one"). The first non-structural character transitions into
    // `markup`, activating the html embed — from then on every path that
    // returns to `markup` routes through `markupReenter` so the invariant
    // "markup has html embed active" always holds.
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
      [/(?=.)/, { token: '', switchTo: '@markup', nextEmbedded: 'html' }]
    ],
    // html-embedded markup state. INVARIANT: whenever we are in `markup`, the
    // html embed is active. Every state that pops back to markup routes
    // through `markupReenter` to re-enter html first. This means `_myTokenize`
    // never sees `markup` with embed=null — which is what would trigger
    // "cannot pop embedded language if not inside one" when a structural rule
    // with `nextEmbedded: '@pop'` fires.
    //
    // Two tokenization paths use this state:
    //   (1) `_nestedTokenize`: scans rules whose action pops the embed; the
    //       structural rules below are those pop rules.
    //   (2) `_myTokenize`: called on the substring starting at the popOffset;
    //       the pop rule at position 0 is the first (and only) rule to match
    //       before state transitions out of `markup`.
    // All transitions use `switchTo` rather than `next` so the Monarch stack
    // stays flat — otherwise re-entering markup via `markupReenter` would add
    // a frame on every svelte expression close and eventually hit
    // `maxStack` (100).
    markup: [
      [
        /<script(?=\s|>)/,
        { token: 'tag', switchTo: '@scriptOpen.typescript', nextEmbedded: '@pop' }
      ],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css', nextEmbedded: '@pop' }],
      [/<!--/, { token: 'comment', switchTo: '@comment', nextEmbedded: '@pop' }],
      [/\{\s*\/(if|each|await|key|snippet)\s*\}/, 'keyword.control'],
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
    // Re-entry shim: every state that finishes and returns to markup context
    // switches to this state (with `nextEmbedded: '@pop'` if it had an embed
    // to pop). A zero-width `@rematch` then re-enters the html embed and
    // switches to `markup`. `@rematch` short-circuits Monarch's progress
    // check — a zero-width match that stays in the same state and stack
    // depth otherwise throws "no progress in tokenizer".
    markupReenter: [[/(?=.)/, { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }]],
    comment: [
      [/-->/, { token: 'comment', switchTo: '@markupReenter' }],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    // Once the typescript embed is active inside an expression, Monaco only
    // consults parent rules whose action ends the embed. That means a brace
    // counter cannot run from inside the embed, so expressions containing
    // nested braces (e.g. `class={{ active: foo }}` or `{foo({ bar: 1 })}`)
    // close at the first inner `}` and the trailing `}` falls into markup.
    // Matches the RFC's note that regex-based grammars have edge cases;
    // the common single-brace case `{count}` works correctly.
    svelteExpressionEnter: [
      // Empty expression `{}`: entry popped the html embed, but we never
      // entered the typescript embed, so only the state needs to unwind.
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter' }],
      [/(?=.)/, { token: '', switchTo: '@svelteExpression', nextEmbedded: 'typescript' }]
    ],
    svelteExpression: [
      [/\}/, { token: 'delimiter.curly', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    svelteBlockExpressionEnter: [
      [/\}/, { token: 'keyword.control', switchTo: '@markupReenter' }],
      [/(?=.)/, { token: '', switchTo: '@svelteBlockExpression', nextEmbedded: 'typescript' }]
    ],
    svelteBlockExpression: [
      [/\}/, { token: 'keyword.control', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    scriptOpen: [
      // Self-closing `<script/>` didn't enter an embed, but it might have been
      // entered from markup (which popped html on entry). Re-enter uniformly.
      [/\/>/, { token: 'tag', switchTo: '@markupReenter' }],
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
    scriptBody: [
      [/<\/script\s*>/, { token: 'tag', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    styleOpen: [
      [/\/>/, { token: 'tag', switchTo: '@markupReenter' }],
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
    styleBody: [
      [/<\/style\s*>/, { token: 'tag', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
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
