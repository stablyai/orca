import type * as Monaco from 'monaco-editor'
import {
  conf as markdownConf,
  language as markdownLanguage
} from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js'

import { tagCloseWithinEmbedBudget } from './monarch-embed-entry-budget'

type QuartoMonaco = {
  languages: Pick<
    typeof Monaco.languages,
    'getLanguages' | 'register' | 'setLanguageConfiguration' | 'setMonarchTokensProvider'
  >
}

export const QUARTO_LANGUAGE_ID = 'quarto'

// Quarto files are edited as Markdown: same comment syntax and bracket pairs.
export const quartoLanguageConfiguration: Monaco.languages.LanguageConfiguration = markdownConf

const markdownTokenizer = markdownLanguage.tokenizer

// `$S2` substitutes the opening fence; a regex literal would interpret `$` as an anchor.
const CLOSING_FENCE = '^\\s*$S2`*\\s*$'

// Extend Markdown so bundled rules and embedded tokenizers stay authoritative.
export const quartoMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  ...markdownLanguage,
  tokenPostfix: '.qmd',
  start: 'quartoStart',
  tokenizer: {
    ...markdownTokenizer,
    // Inline script/style embeds inherit Markdown's recursion risk.
    tag: [
      ...markdownTokenizer.tag.map((rule): Monaco.languages.IMonarchLanguageRule =>
        Array.isArray(rule) && rule[0] instanceof RegExp && rule[0].source === '>'
          ? [tagCloseWithinEmbedBudget, rule[1]]
          : rule
      ),
      [/>/, 'tag', '@pop']
    ],
    // Only the initial state may interpret `---` as YAML front matter.
    quartoStart: [
      [
        /^---\s*$/,
        { token: 'meta.separator', switchTo: '@quartoFrontMatter', nextEmbedded: 'yaml' }
      ],
      [/.*/, { token: '@rematch', switchTo: '@root' }]
    ],
    quartoFrontMatter: [
      [/^(?:---|\.\.\.)\s*$/, { token: 'meta.separator', switchTo: '@root', nextEmbedded: '@pop' }],
      [/.*$/, 'variable.source']
    ],
    root: [
      // Escaped cells must consume their closing fence without starting an embed.
      [/^\s*(`{3,})\s*\{\{[^}]*\}\}.*$/, { token: 'string', next: '@quartoRawCell.$1' }],
      // ```{ojs} / ```{d3} are JavaScript dialects Monaco has no language id for.
      [
        /^\s*(`{3,})\s*\{\s*(?:ojs|d3)\b[^}]*\}.*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: 'javascript' }
      ],
      // Unknown engine ids fall back to uncolored content in Monaco.
      [
        /^\s*(`{3,})\s*\{=?\s*([A-Za-z][\w.+-]*)[^}]*\}.*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: '$2' }
      ],
      // Long plain fences must keep shorter inner fences inside the block.
      [
        /^\s*(`{4,})\s*((?:\w|[/\-#])+).*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: '$2' }
      ],
      [/^\s*(`{4,})\s*$/, { token: 'string', next: '@quartoRawCell.$1' }],
      // Pandoc fenced divs: ::: {.callout-note}
      [/^\s*:{3,}.*$/, 'meta.separator'],
      ...markdownTokenizer.root
    ],
    // Embedded-language exits match the pattern alone; guards cannot enforce fence length.
    quartoCell: [
      [CLOSING_FENCE, { token: 'string', next: '@pop', nextEmbedded: '@pop' }],
      [/.*$/, 'variable.source']
    ],
    quartoRawCell: [
      [CLOSING_FENCE, { token: 'string', next: '@pop' }],
      [/.*$/, 'variable.source']
    ]
  }
}

export function registerQuartoLanguage(monaco: QuartoMonaco): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === QUARTO_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: QUARTO_LANGUAGE_ID,
    extensions: ['.qmd', '.rmd', '.rmarkdown'],
    aliases: ['Quarto', 'quarto', 'R Markdown']
  })
  monaco.languages.setLanguageConfiguration(QUARTO_LANGUAGE_ID, quartoLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(QUARTO_LANGUAGE_ID, quartoMonarchLanguage)
}
