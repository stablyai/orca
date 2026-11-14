import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = Pick<typeof Monaco, 'languages'>

// Tags whose body a matching {% end… %} closes; block-form {% set x %} has no '='.
const JINJA_BLOCK_TAGS = 'block|for|if|macro|call|filter|with|raw|autoescape|trans|set(?![^%]*=)'
// A line ending in an opening tag, excluding one-liners like {% if x %}y{% endif %}.
const JINJA_OPEN_LINE = new RegExp(
  `\\{%-?\\s*(?:${JINJA_BLOCK_TAGS}|elif|else)\\b(?!.*\\{%-?\\s*end).*%\\}\\s*$`
)
const JINJA_CLOSE_LINE = /^\s*\{%-?\s*(?:end\w+|elif|else)\b/
const HTML_OPEN_TAG_LINE =
  /<(?!(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b)([\w:-]+)([^/>]*(?!\/)>)[^<]*$/i

function mapJinjaScope(scope: string): string | undefined {
  const language = scope.slice(scope.lastIndexOf('.') + 1)
  if (scope.includes('jinja.delimiter')) {
    return scope.endsWith('.comment') ? 'comment.jinja' : 'delimiter.jinja'
  }
  // Quote and comment punctuation take their parent's color.
  if (/^punctuation\.definition\.(?:string|comment)\./.test(scope)) {
    return undefined
  }
  if (scope.startsWith('punctuation.definition.tag.')) {
    return `delimiter.${language}`
  }
  if (scope.startsWith('entity.name.tag.')) {
    return `tag.${language}`
  }
  if (
    scope.startsWith('entity.other.attribute-name.') ||
    scope.startsWith('support.type.property-name.')
  ) {
    return `attribute.name.${language}`
  }
  if (scope.startsWith('support.constant.')) {
    return `attribute.value.${language}`
  }
  if (scope.startsWith('constant.numeric.')) {
    return `number.${language}`
  }
  if (scope.startsWith('constant.character.escape.')) {
    return `string.escape.${language}`
  }
  // Filters and tests read as calls, distinct from the variables they apply to.
  if (
    /^variable\.other\.jinja\.(?:filter|test)$/.test(scope) ||
    scope.startsWith('entity.name.function.')
  ) {
    return `type.${language}`
  }
  if (scope.startsWith('variable.language.')) {
    return `variable.predefined.${language}`
  }
  if (scope.startsWith('storage.')) {
    return `keyword.${language}`
  }
  if (scope.startsWith('keyword.operator.')) {
    return `operator.${language}`
  }
  if (/^(?:comment|string|keyword|constant|variable\.other|invalid)\./.test(scope)) {
    return scope
  }
  return scope.startsWith('punctuation.') ? `delimiter.${language}` : undefined
}

// Why: stock Monaco themes style none of entity.*/storage.*/support.*; map to the tokens Monaco's Twig uses.
function mapJinjaTokenScopes(scopes: readonly string[]): string {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const mapped = mapJinjaScope(scopes[index])
    if (mapped) {
      return mapped
    }
  }
  return ''
}

// jinja.mjs bundles html, jinja-html and jinja; jinja-html.mjs alone lacks the source.jinja it includes.
async function loadJinjaGrammars(root: 'jinja' | 'jinja-html'): Promise<LanguageRegistration[]> {
  const { default: bundled } = await import('shiki/langs/jinja.mjs')
  const grammars = bundled.map((grammar) =>
    grammar.name === 'jinja' ? withJinjaNumbers(grammar) : grammar
  )
  const rootGrammar = grammars.find((grammar) => grammar.name === root)!
  return [...grammars.filter((grammar) => grammar !== rootGrammar), rootGrammar]
}

// The upstream grammar has no numeric literal rule, leaving range(10) or default(8080) uncolored.
function withJinjaNumbers(grammar: LanguageRegistration): LanguageRegistration {
  const expression = grammar.repository.expression
  const numeric = {
    match: '\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b',
    name: 'constant.numeric.jinja'
  }
  const repository: LanguageRegistration['repository'] = Object.assign({}, grammar.repository, {
    expression: { ...expression, patterns: [...(expression.patterns ?? []), numeric] }
  })
  return { ...grammar, repository }
}

const loadJinjaHtmlTextMateGrammar = () => loadJinjaGrammars('jinja-html')
// Bare Jinja keeps surrounding YAML/config text plain instead of parsing it as HTML.
const loadJinjaTextMateGrammar = () => loadJinjaGrammars('jinja')

function jinjaConfiguration({
  IndentAction
}: MonacoModule['languages']): Monaco.languages.LanguageConfiguration {
  return {
    comments: { blockComment: ['{#', '#}'] },
    brackets: [
      ['{#', '#}'],
      ['{%', '%}'],
      ['{{', '}}'],
      ['{', '}'],
      ['(', ')'],
      ['[', ']']
    ],
    autoClosingPairs: [
      { open: '{# ', close: ' #}' },
      { open: '{% ', close: ' %}' },
      { open: '{{ ', close: ' }}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] }
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '<', close: '>' }
    ],
    indentationRules: {
      increaseIndentPattern: JINJA_OPEN_LINE,
      decreaseIndentPattern: JINJA_CLOSE_LINE
    },
    onEnterRules: [
      {
        beforeText: JINJA_OPEN_LINE,
        afterText: JINJA_CLOSE_LINE,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: HTML_OPEN_TAG_LINE,
        afterText: /^<\/[\w:-]+\s*>/i,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      { beforeText: HTML_OPEN_TAG_LINE, action: { indentAction: IndentAction.Indent } }
    ],
    folding: {
      markers: {
        start: new RegExp(`^\\s*(?:\\{%-?\\s*(?:${JINJA_BLOCK_TAGS})\\b|<!--\\s*#region\\b)`),
        end: /^\s*(?:\{%-?\s*end\w+\b|<!--\s*#endregion\b)/
      }
    }
  }
}

export function registerJinjaLanguages(monaco: MonacoModule): void {
  const configuration = jinjaConfiguration(monaco.languages)
  registerTextMateLanguage(monaco, {
    language: { id: 'jinja-html', aliases: ['Jinja HTML', 'jinja-html', 'htmldjango'] },
    configuration,
    loadGrammar: loadJinjaHtmlTextMateGrammar,
    mapTokenScopes: mapJinjaTokenScopes
  })
  registerTextMateLanguage(monaco, {
    language: { id: 'jinja', aliases: ['Jinja', 'jinja', 'jinja2', 'j2'] },
    configuration,
    loadGrammar: loadJinjaTextMateGrammar,
    mapTokenScopes: mapJinjaTokenScopes
  })
}
