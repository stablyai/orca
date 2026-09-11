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
    // Entry state: fires once at file start with no embed on the stack.
    // Modeled after the Svelte tokenizer — structural rules MUST NOT emit
    // `nextEmbedded: '@pop'` from here. Only the frontmatter fence is
    // recognised at file start; everything else (markup, `{expr}`,
    // `<script>`/`<style>`) is handled after we've routed through
    // `markupReenter` so the invariant "markup has html embed active" is
    // satisfied by a single code path. Without this, an interpolation in
    // the very first markup line popped the html embed before any push had
    // occurred via this entry — Monaco rejects that with "cannot pop
    // embedded language if not inside one".
    root: [
      // Astro frontmatter: `---` at file start opens a TypeScript fence
      // closed by another `---` line. The opening line itself enters the
      // typescript embed.
      [/---\s*$/, { token: 'keyword', switchTo: '@frontmatter', nextEmbedded: 'typescript' }],
      [/(?=.)/, { token: '@rematch', switchTo: '@markupReenter' }]
    ],
    // Inside the frontmatter fence the typescript embed is active; only a
    // closing `---` on its own line pops it. Astro requires the closing
    // fence at column 0.
    frontmatter: [
      [/^---\s*$/, { token: 'keyword', switchTo: '@markupReenter', nextEmbedded: '@pop' }]
    ],
    // html-embedded markup state. Mirrors Svelte's invariant: whenever we
    // are in `markup`, the html embed is active. Every state that pops back
    // to markup routes through `markupReenter` to push html again. Astro
    // expressions are plain JS (no `{#if}`-style block syntax), so a single
    // `{` rule handles all interpolations.
    markup: [
      [
        /<script(?=\s|>)/,
        { token: 'tag', switchTo: '@scriptOpen.javascript', nextEmbedded: '@pop' }
      ],
      [/<style(?=\s|>)/, { token: 'tag', switchTo: '@styleOpen.css', nextEmbedded: '@pop' }],
      [/<!--/, { token: 'comment', switchTo: '@comment', nextEmbedded: '@pop' }],
      [/\{/, { token: 'delimiter.curly', switchTo: '@astroExpressionEnter', nextEmbedded: '@pop' }]
    ],
    // `@rematch` is required: on a zero-width match Monarch's progress check
    // `continue`s and silently drops a pending `nextEmbedded` for any other
    // token, leaving `markup` without the html embed its pop rules assume.
    markupReenter: [
      [
        restOfLineWithinEmbedBudget,
        { token: '@rematch', switchTo: '@markup', nextEmbedded: 'html' }
      ],
      [/(?=.)/, { token: '@rematch', switchTo: '@markupPlain' }]
    ],
    // Same structure as `markup` with no embeds, so the rest of an over-budget
    // line cannot deepen the recursion. The next line starts here and re-enters
    // the html embed as soon as it fits the budget.
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
    // Once the typescript embed is active inside an expression, Monaco only
    // consults parent rules whose action ends the embed. A brace counter
    // therefore cannot run from inside the embed, so expressions with
    // nested braces (e.g. `{items.map((x) => ({y: x}))}`) close at the
    // first inner `}`. The common single-brace case `{title}` works.
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
    // Over-budget mirror of the body: re-enters `$S2` as soon as the rest of
    // the line fits, so a long opening line does not grey out the whole block.
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
