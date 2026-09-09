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

// `$S2` is the opening fence carried in the cell state's name, substituted by
// Monaco when the rule is resolved for that state. A string keeps that visible;
// as a regex literal the `$` would read as an end anchor.
const CLOSING_FENCE = '^\\s*$S2`*\\s*$'

// Why: Quarto is Markdown plus a YAML header and executable cells, so the whole
// Markdown grammar is reused and only the Quarto-specific shapes are added in
// front of it. Cell bodies run through `quartoCell`/`quartoRawCell` rather than
// Markdown's own code-block states, because a Quarto fence can be longer than
// three backticks and those states close on exactly three.
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
      [/^\s*(`{3,})\s*\{\{[^}]*\}\}.*$/, { token: 'string', next: '@quartoRawCell.$1' }],
      // ```{ojs} / ```{d3} are JavaScript dialects Monaco has no language id for.
      [
        /^\s*(`{3,})\s*\{\s*(?:ojs|d3)\b[^}]*\}.*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: 'javascript' }
      ],
      // ```{r}, ```{python, echo=FALSE}, ```{=html} — an engine Monaco does not
      // know (tikz, dot, …) stays uncolored instead of erroring.
      [
        /^\s*(`{3,})\s*\{=?\s*([A-Za-z][\w.+-]*)[^}]*\}.*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: '$2' }
      ],
      // A ````-fenced block is how a Quarto document shows a ``` fence verbatim.
      // Markdown's own fence rules match exactly three backticks, so the longer
      // form has to be routed here or its inner ``` reads as a block opener.
      [
        /^\s*(`{4,})\s*((?:\w|[/\-#])+).*$/,
        { token: 'string', next: '@quartoCell.$1', nextEmbedded: '$2' }
      ],
      [/^\s*(`{4,})\s*$/, { token: 'string', next: '@quartoRawCell.$1' }],
      // Pandoc fenced divs: ::: {.callout-note}
      [/^\s*:{3,}.*$/, 'meta.separator'],
      ...markdownTokenizer.root
    ],
    // Why not Markdown's own `codeblock`/`codeblockgh`: both close on exactly
    // three backticks, so a ````-fenced cell never ended and the rest of the
    // file was tokenized as code. The opening fence travels in the state name
    // and `$S2` puts it back into the closing pattern, so a cell closes on a
    // fence at least as long as the one that opened it — what Quarto and
    // CommonMark require. Written as a pattern rather than a `cases` guard
    // because Monaco decides where an embedded language ends by matching this
    // regex alone (`_findLeavingNestedLanguageOffset` never runs guards): a
    // shorter fence inside the cell has to miss the pattern itself, or the
    // engine stops tokenizing at the very line a long fence exists to show.
    quartoCell: [
      [CLOSING_FENCE, { token: 'string', next: '@pop', nextEmbedded: '@pop' }],
      [/.*$/, 'variable.source']
    ],
    // The same fence bookkeeping for cells with no embedded language: escaped
    // ```{{python}} cells and plain ```` blocks.
    quartoRawCell: [
      [CLOSING_FENCE, { token: 'string', next: '@pop' }],
      [/.*$/, 'variable.source']
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
