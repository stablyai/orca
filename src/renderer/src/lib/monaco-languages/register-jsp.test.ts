import { describe, expect, it, vi } from 'vitest'
import {
  jspHtmlModeConfiguration,
  jspLanguageConfiguration,
  jspMonarchLanguage,
  registerJspLanguage
} from './register-jsp'

type MonarchAction = {
  token?: string
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

function rulesFor(state: string): [RegExp, string | MonarchAction, string?][] {
  const tokenizer = jspMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  return tokenizer[state].flatMap((rule) =>
    isRuleEntry(rule) ? [rule] : rulesFor(rule.include.replace(/^@/, ''))
  )
}

function findRule(
  state: string,
  source: string
): [RegExp, string | MonarchAction, string?] | undefined {
  return rulesFor(state).find(([regexp]) => {
    regexp.lastIndex = 0
    const match = regexp.exec(source)
    return match !== null && match.index === 0
  })
}

function tokenFor(state: string, source: string): string | undefined {
  const rule = findRule(state, source)
  if (!rule) {
    return undefined
  }
  const [, action] = rule
  return typeof action === 'string' ? action : action.token
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

function matchLengthFor(state: string, source: string): number | undefined {
  const rule = findRule(state, source)
  if (!rule) {
    return undefined
  }
  const [regexp] = rule
  regexp.lastIndex = 0
  return regexp.exec(source)?.[0].length
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
    // A second registration would create another worker and provider set.
    expect(registerHTMLLanguageService).toHaveBeenCalledTimes(1)
    expect(registerHTMLLanguageService).toHaveBeenCalledWith(
      'jsp',
      undefined,
      jspHtmlModeConfiguration
    )
  })

  it('keeps buffer-editing HTML features off and read-only ones on', () => {
    expect(jspHtmlModeConfiguration.rename).toBe(false)
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
    expect(nextStateFor('root', '#{bean.value}')).toBe('elExpression')
    expect(nextStateFor('root', '<!-- sent to the browser -->')).toBe('htmlComment')
  })

  it('consumes the whole opening delimiter for each JSP construct', () => {
    expect(matchLengthFor('root', '<%-- hidden --%>')).toBe(4)
    expect(matchLengthFor('root', '<%@ page %>')).toBe(3)
    expect(matchLengthFor('root', '<%= user.getName() %>')).toBe(3)
    expect(matchLengthFor('root', '<%! int counter = 0; %>')).toBe(3)
    expect(matchLengthFor('root', '<% int total = 0; %>')).toBe(2)
  })

  it('matches namespaced tag names in full, not just the prefix', () => {
    // The generic tag rule would stop at `<c`, so match length is what
    // distinguishes the JSTL rule from it.
    expect(matchLengthFor('root', '<c:if test="${ok}">')).toBe(5)
    expect(matchLengthFor('root', '</c:forEach>')).toBe(11)
    expect(matchLengthFor('root', '<div class="row">')).toBe(4)
  })

  it('leaves every nested state through its closing delimiter', () => {
    expect(nextStateFor('jspDirective', '%>')).toBe('pop')
    expect(nextStateFor('jspScriptlet', '%>')).toBe('pop')
    expect(nextStateFor('jspComment', '--%>')).toBe('pop')
    expect(nextStateFor('htmlComment', '-->')).toBe('pop')
    expect(nextStateFor('javaBlockComment', '*/')).toBe('pop')
    expect(nextStateFor('elExpression', '}')).toBe('pop')
    expect(nextStateFor('attributeValueDouble', '" />')).toBe('pop')
    expect(nextStateFor('attributeValueSingle', "' />")).toBe('pop')
    expect(nextStateFor('tagRest', '>')).toBe('pop')
    expect(nextStateFor('tagRest', '/>')).toBe('pop')
  })

  it('treats a JSP comment inside a tag as a comment, not a scriptlet', () => {
    // Without this rule the `--%>` terminator is swallowed by the operator run
    // and Java tokenization leaks to end of file.
    expect(nextStateFor('tagRest', '<%-- escapeXml="false" --%> />')).toBe('jspComment')
    expect(nextStateFor('attributeValueDouble', '<%-- x --%>"')).toBe('jspComment')
    expect(nextStateFor('attributeValueSingle', "<%-- x --%>'")).toBe('jspComment')
  })

  it('does not let an operator run swallow the scriptlet terminator', () => {
    expect(matchLengthFor('jspScriptlet', '++%>')).toBe(2)
    expect(tokenFor('jspScriptlet', '% 2')).toBe('keyword.operator')
  })

  it('does not let a comment swallow the scriptlet terminator', () => {
    // A line comment before the terminator is valid JSP: the container
    // finds the closing delimiter first, so the comment must stop there.
    expect(matchLengthFor('jspScriptlet', '// done %>')).toBe(8)
    expect(matchLengthFor('javaBlockComment', ' note %> */')).toBe(6)
  })

  it('keeps scriptlet-looking text inert inside a JSP comment', () => {
    expect(tokenFor('jspComment', '<% still a comment --%>')).toBe('comment')
    expect(nextStateFor('jspComment', '<% still a comment --%>')).toBeUndefined()
  })

  it('does not close a tag on a `>` inside an attribute value', () => {
    expect(tokenFor('attributeValueDouble', '> b">')).toBe('attribute.value')
    expect(nextStateFor('attributeValueDouble', '> b">')).toBeUndefined()
    expect(tokenFor('elExpression', "> b ? 'x' : 'y'}")).toBe('keyword.operator')
  })

  it('is case-sensitive for Java tokens but not for script and style tags', () => {
    expect(jspMonarchLanguage.ignoreCase).toBeUndefined()
    // `List list` must not colour the variable as a type.
    expect(tokenFor('jspScriptlet', 'List list')).toBe('type')
    expect(tokenFor('jspScriptlet', 'list = null')).toBe('identifier')
    expect(tokenFor('jspScriptlet', 'IF (x)')).toBe('identifier')
    expect(nextStateFor('root', '<SCRIPT type="text/javascript">')).toBe('scriptOpen')
    expect(nextStateFor('root', '<STYLE>')).toBe('styleOpen')
  })

  it('pops the embedded language when the script or style block closes', () => {
    const scriptRule = rulesFor('scriptBody')[0]
    const styleRule = rulesFor('styleBody')[0]
    const scriptAction = scriptRule[1] as MonarchAction
    const styleAction = styleRule[1] as MonarchAction

    // Monarch throws 'no rule containing nextEmbedded: "@pop"' without these.
    expect(scriptAction.nextEmbedded).toBe('@pop')
    expect(scriptAction.next).toBe('@pop')
    expect(styleAction.nextEmbedded).toBe('@pop')
    expect(styleAction.next).toBe('@pop')

    expect(scriptRule[0].test('</SCRIPT >')).toBe(true)
    expect(styleRule[0].test('</STYLE>')).toBe(true)
  })

  it('embeds javascript and css when the opening tag closes', () => {
    const scriptOpen = rulesFor('scriptOpen').find(
      (rule) => typeof rule[1] === 'object' && rule[1].nextEmbedded === 'javascript'
    )
    const styleOpen = rulesFor('styleOpen').find(
      (rule) => typeof rule[1] === 'object' && rule[1].nextEmbedded === 'css'
    )

    expect(scriptOpen).toBeDefined()
    expect(styleOpen).toBeDefined()
    expect((scriptOpen?.[1] as MonarchAction | undefined)?.switchTo).toBe('@scriptBody')
    expect((styleOpen?.[1] as MonarchAction | undefined)?.switchTo).toBe('@styleBody')
  })

  it('uses theme-backed token names for operators', () => {
    // vs-dark defines operator.scss/sql/swift but no plain `operator`, so a
    // bare 'operator' token would render unstyled.
    expect(tokenFor('jspScriptlet', '>= 10')).toBe('keyword.operator')
    expect(tokenFor('elExpression', 'ne 0')).toBe('keyword.operator')
    expect(JSON.stringify(jspMonarchLanguage.tokenizer)).not.toContain('"operator"')
  })

  it('only references tokenizer states that exist', () => {
    const tokenizer = jspMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
    const declared = new Set(Object.keys(tokenizer))

    Object.values(tokenizer).forEach((rules) => {
      rules.forEach((rule) => {
        if (!isRuleEntry(rule)) {
          expect(declared).toContain(rule.include.replace(/^@/, ''))
          return
        }
        const [, action, shortcut] = rule
        const targets = [
          shortcut,
          typeof action === 'object' ? action.next : undefined,
          typeof action === 'object' ? action.switchTo : undefined
        ]
        targets.forEach((target) => {
          if (target && target !== '@pop' && target !== '@popall') {
            expect(declared).toContain(target.replace(/^@/, ''))
          }
        })
      })
    })
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
