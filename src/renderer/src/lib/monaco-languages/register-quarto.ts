import type * as Monaco from 'monaco-editor'
import {
  conf as markdownConf,
  language as markdownLanguage
} from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js'

type MonacoModule = typeof Monaco

export const QUARTO_LANGUAGE_ID = 'quarto'

// Quarto files are edited as Markdown: same comment syntax and bracket pairs.
export const quartoLanguageConfiguration: Monaco.languages.LanguageConfiguration = markdownConf

const markdownTokenizer = markdownLanguage.tokenizer as Record<
  string,
  Monaco.languages.IMonarchLanguageRule[]
>

// Why: Quarto is Markdown plus a YAML header and executable cells, so the whole
// Markdown grammar is reused and only the two Quarto-specific shapes are added
// in front of it. Cell bodies reuse Markdown's own `codeblockgh` state, whose
// `nextEmbedded: '@pop'` rule ends the embedded language at the closing fence.
export const quartoMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  ...markdownLanguage,
  tokenPostfix: '.qmd',
  start: 'quartoStart',
  tokenizer: {
    ...markdownTokenizer,
    // Only line 1 is tokenized from the entry state, which is the one place a
    // leading `---` means YAML front matter rather than a horizontal rule.
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
      // ```{{python}} escapes a cell so Quarto shows it without running it. It
      // matches no Markdown fence rule, so without this the closing fence would
      // be read as an opening one and swallow the rest of the document.
      [/^\s*```+\s*\{\{[^}]*\}\}.*$/, { token: 'string', next: '@codeblock' }],
      // ```{ojs} / ```{d3} are JavaScript dialects Monaco has no language id for.
      [
        /^\s*```+\s*\{\s*(?:ojs|d3)\b[^}]*\}.*$/,
        { token: 'string', next: '@codeblockgh', nextEmbedded: 'javascript' }
      ],
      // ```{r}, ```{python, echo=FALSE}, ```{=html} — an engine Monaco does not
      // know (tikz, dot, …) stays uncolored instead of erroring.
      [
        /^\s*```+\s*\{=?\s*([A-Za-z][\w.+-]*)[^}]*\}.*$/,
        { token: 'string', next: '@codeblockgh', nextEmbedded: '$1' }
      ],
      // Pandoc fenced divs: ::: {.callout-note}
      [/^\s*:{3,}.*$/, 'meta.separator'],
      ...markdownTokenizer.root
    ]
  }
}

export function registerQuartoLanguage(monaco: MonacoModule): void {
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
