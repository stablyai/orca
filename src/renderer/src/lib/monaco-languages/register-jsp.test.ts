import { describe, expect, it, vi } from 'vitest'
import {
  jspHtmlModeConfiguration,
  jspLanguageConfiguration,
  jspMonarchLanguage,
  registerJspLanguage
} from './register-jsp'

type MonarchAction = {
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

function findRule(
  state: string,
  source: string
): [RegExp, string | MonarchAction, string?] | undefined {
  const tokenizer = jspMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const matched = tokenizer[state].find((rule) => {
    if (!isRuleEntry(rule)) {
      return false
    }
    const [regexp] = rule
    regexp.lastIndex = 0
    const match = regexp.exec(source)
    return match !== null && match.index === 0
  })

  return matched && isRuleEntry(matched) ? matched : undefined
}

function tokenFor(state: string, source: string): string | undefined {
  const rule = findRule(state, source)
  if (!rule) {
    return undefined
  }
  const [, action] = rule
  return typeof action === 'string' ? action : action.next
}

function nextStateFor(state: string, source: string): string | undefined {
  const rule = findRule(state, source)
  if (!rule) {
    return undefined
  }
  const [, action, shortcut] = rule
  const next = typeof action === 'object' ? (action.next ?? action.switchTo) : shortcut
  return next?.replace(/^@/, '')
}

describe('registerJspLanguage', () => {
  it('registers the jsp language and attaches the HTML language service once', () => {
    const languages: { id: string }[] = [{ id: 'html' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const getLanguages = vi.fn(() => languages)
    const registerHTMLLanguageService = vi.fn()
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages
      },
      html: { registerHTMLLanguageService }
    }

    registerJspLanguage(monacoMock as never)
    registerJspLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'jsp',
      extensions: ['.jsp', '.jspf'],
      aliases: ['JSP', 'JavaServer Pages']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('jsp', jspMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('jsp', jspLanguageConfiguration)
    expect(registerHTMLLanguageService).toHaveBeenCalledTimes(1)
    expect(registerHTMLLanguageService).toHaveBeenCalledWith(
      'jsp',
      undefined,
      jspHtmlModeConfiguration
    )
  })

  it('keeps HTML diagnostics and formatting off while keeping completion on', () => {
    expect(jspHtmlModeConfiguration.diagnostics).toBe(false)
    expect(jspHtmlModeConfiguration.documentFormattingEdits).toBe(false)
    expect(jspHtmlModeConfiguration.documentRangeFormattingEdits).toBe(false)
    expect(jspHtmlModeConfiguration.completionItems).toBe(true)
    expect(jspHtmlModeConfiguration.hovers).toBe(true)
    expect(jspHtmlModeConfiguration.foldingRanges).toBe(true)
  })

  it('enters dedicated states for directives, scriptlets, comments and EL', () => {
    expect(nextStateFor('root', '<%@ page contentType="text/html" %>')).toBe('jspDirective')
    expect(nextStateFor('root', '<% int total = 0; %>')).toBe('jspScriptlet')
    expect(nextStateFor('root', '<%= user.getName() %>')).toBe('jspScriptlet')
    expect(nextStateFor('root', '<%-- hidden from output --%>')).toBe('jspComment')
    expect(nextStateFor('root', '${user.name}')).toBe('elExpression')
    expect(nextStateFor('root', '<!-- sent to the browser -->')).toBe('htmlComment')
  })

  it('treats JSTL and custom tag prefixes as tags', () => {
    expect(tokenFor('root', '<c:if test="${ok}">')).toBe('tag')
    expect(tokenFor('root', '</c:forEach>')).toBe('tag')
    expect(tokenFor('root', '<my:widget />')).toBe('tag')
    expect(tokenFor('root', '<div class="row">')).toBe('tag')
  })

  it('reads EL and scriptlets inside tag attribute values', () => {
    expect(nextStateFor('attributeValueDouble', '${row.id}"')).toBe('elExpression')
    expect(nextStateFor('attributeValueDouble', '<%= row.getId() %>"')).toBe('jspScriptlet')
    expect(nextStateFor('tagRest', '${row.id}')).toBe('elExpression')
  })

  it('uses theme-backed token names for operators', () => {
    // vs-dark defines operator.scss/sql/swift but no plain `operator`, so a
    // bare 'operator' token would render unstyled.
    expect(tokenFor('jspScriptlet', '>= 10')).toBe('keyword.operator')
    expect(tokenFor('elExpression', 'ne 0')).toBe('keyword.operator')
    expect(JSON.stringify(jspMonarchLanguage.tokenizer)).not.toContain('"operator"')
  })

  it('embeds javascript and css for script and style blocks', () => {
    const tokenizer = jspMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
    const scriptRule = tokenizer.scriptOpen.find(
      (rule) => isRuleEntry(rule) && typeof rule[1] === 'object'
    )
    const styleRule = tokenizer.styleOpen.find(
      (rule) => isRuleEntry(rule) && typeof rule[1] === 'object'
    )

    expect(isRuleEntry(scriptRule!) && (scriptRule![1] as MonarchAction).nextEmbedded).toBe(
      'javascript'
    )
    expect(isRuleEntry(styleRule!) && (styleRule![1] as MonarchAction).nextEmbedded).toBe('css')
  })

  it('excludes angle brackets from bracket pairs so comparisons do not mismatch', () => {
    const bracketChars = [
      ...(jspLanguageConfiguration.brackets ?? []).flat(),
      ...(jspLanguageConfiguration.autoClosingPairs ?? []).flatMap((pair) =>
        'open' in pair ? [pair.open, pair.close] : []
      )
    ]

    expect(bracketChars).not.toContain('<')
    expect(bracketChars).not.toContain('>')
  })
})
