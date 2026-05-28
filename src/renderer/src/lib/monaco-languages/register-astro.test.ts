import { describe, expect, it, vi } from 'vitest'
import {
  astroLanguageConfiguration,
  astroMonarchLanguage,
  registerAstroLanguage
} from './register-astro'

type MonarchAction = {
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

function normalizeState(nextState: string): string {
  return nextState.startsWith('@') ? nextState.slice(1) : nextState
}

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

function getRuleAction(rule: [RegExp, string | MonarchAction, string?]): MonarchAction | undefined {
  const [, action, nextStateShortcut] = rule
  return typeof action === 'object'
    ? action
    : nextStateShortcut
      ? { next: nextStateShortcut }
      : undefined
}

function findRuleAction(
  state: string,
  source: string,
  { embedPopOnly = false }: { embedPopOnly?: boolean } = {}
): MonarchAction | undefined {
  const tokenizer = astroMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const stateRules = tokenizer[state] ?? tokenizer[state.split('.')[0]]
  const candidateRules = embedPopOnly
    ? stateRules.filter((rule) => {
        if (!isRuleEntry(rule)) {
          return false
        }
        return getRuleAction(rule)?.nextEmbedded === '@pop'
      })
    : stateRules
  const matchedRule = candidateRules.find((rule) => {
    if (!isRuleEntry(rule)) {
      return false
    }
    const [regexp] = rule
    regexp.lastIndex = 0
    const match = regexp.exec(source)
    return match !== null && match.index === 0
  })

  return matchedRule && isRuleEntry(matchedRule) ? getRuleAction(matchedRule) : undefined
}

function collectFixtureRuleActions(source: string): string[] {
  const ruleActions: string[] = []
  const tokenizer = astroMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const lines = source.split('\n')
  const checks: { line: number; state: string; pattern: string }[] = [
    { line: 1, state: 'root', pattern: '---' },
    { line: 4, state: 'frontmatter', pattern: '---' },
    // After the frontmatter closes we are back in `markupReenter`; the next
    // non-structural character switches into `markup` with html active.
    { line: 6, state: 'markupReenter', pattern: '' },
    { line: 6, state: 'markup', pattern: '{' },
    { line: 6, state: 'astroExpression', pattern: '}' },
    { line: 8, state: 'markup', pattern: '<script' },
    { line: 8, state: 'scriptOpen.javascript', pattern: '>' },
    { line: 10, state: 'scriptBody.javascript', pattern: '</script>' },
    { line: 12, state: 'markup', pattern: '<style' },
    { line: 12, state: 'styleOpen.css', pattern: '>' },
    { line: 14, state: 'styleBody.css', pattern: '</style>' }
  ]

  checks.forEach((check) => {
    const line = lines.at(check.line - 1) ?? ''
    const stateRules = tokenizer[check.state] ?? tokenizer[check.state.split('.')[0]]
    const matchedRule = stateRules.find((rule) => {
      if (!isRuleEntry(rule)) {
        return false
      }
      const [regexp] = rule
      regexp.lastIndex = 0
      const match = regexp.exec(line)
      return match !== null && match[0] === check.pattern
    })
    if (!matchedRule || !isRuleEntry(matchedRule)) {
      return
    }

    const actionObject = getRuleAction(matchedRule)

    const nextState = actionObject?.next ? normalizeState(actionObject.next) : '-'
    const nextEmbedded = actionObject?.nextEmbedded ?? '-'
    const switchTo = actionObject?.switchTo ? normalizeState(actionObject.switchTo) : '-'
    ruleActions.push(
      `${check.line}:${check.state}:${check.pattern || '<html>'} -> next=${nextState}, embedded=${nextEmbedded}, switch=${switchTo}`
    )
  })

  return ruleActions
}

describe('registerAstroLanguage registration', () => {
  it('registers the astro language, Monarch tokenizer, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'typescript' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const getLanguages = vi.fn(() => languages)
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages
      }
    }

    registerAstroLanguage(monacoMock as never)
    registerAstroLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'astro',
      extensions: ['.astro'],
      aliases: ['Astro']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('astro', astroMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('astro', astroLanguageConfiguration)
  })
})

describe('astro tokenizer transitions', () => {
  it('captures Astro tokenizer transitions for a representative component fixture', () => {
    const fixture = `---
import Layout from '../layouts/Layout.astro'
const title = 'Home'
---

<h1>{title}</h1>

<script>
  console.log('hi')
</script>

<style lang="scss">
  h1 { color: rebeccapurple; }
</style>`

    const ruleActions = collectFixtureRuleActions(fixture)

    expect(ruleActions).toMatchInlineSnapshot(`
      [
        "1:root:--- -> next=-, embedded=typescript, switch=frontmatter",
        "4:frontmatter:--- -> next=-, embedded=@pop, switch=markupReenter",
        "6:markupReenter:<html> -> next=-, embedded=html, switch=markup",
        "6:markup:{ -> next=-, embedded=@pop, switch=astroExpressionEnter",
        "6:astroExpression:} -> next=-, embedded=@pop, switch=markupReenter",
        "8:markup:<script -> next=-, embedded=@pop, switch=scriptOpen.javascript",
        "8:scriptOpen.javascript:> -> next=-, embedded=$S2, switch=scriptBody.$S2",
        "10:scriptBody.javascript:</script> -> next=-, embedded=@pop, switch=markupReenter",
        "12:markup:<style -> next=-, embedded=@pop, switch=styleOpen.css",
        "12:styleOpen.css:> -> next=-, embedded=$S2, switch=styleBody.$S2",
        "14:styleBody.css:</style> -> next=-, embedded=@pop, switch=markupReenter",
      ]
    `)
  })
})

describe('astro tokenizer regressions', () => {
  // Regression: a file that opens with a markup expression like `{title}` has
  // no html embed active yet. If `root` itself ever emitted `nextEmbedded:
  // '@pop'` Monaco would throw "cannot pop embedded language if not inside
  // one" before any push had occurred. Enforce the invariant directly.
  it('never pops an embedded language from the root state', () => {
    const tokenizer = astroMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
    const popRules = tokenizer.root.filter((rule) => {
      if (!isRuleEntry(rule)) {
        return false
      }
      return getRuleAction(rule)?.nextEmbedded === '@pop'
    })
    expect(popRules).toHaveLength(0)
  })

  // Regression (verified live in the Electron app): when entry from root went
  // straight to `@markup` with `nextEmbedded: 'html'`, while the embed-pop
  // path also went via `@markupReenter`, Monarch's nested tokenizer reported
  // "cannot pop embedded language if not inside one" on `{expr}` in markup.
  // Routing every push of the html embed through `markupReenter` keeps the
  // embed-stack invariant identical for every entry into `markup`.
  it('routes all entries into markup through markupReenter', () => {
    expect(findRuleAction('root', '<h1>Hello</h1>')).toMatchObject({
      switchTo: '@markupReenter'
    })
    expect(findRuleAction('root', '{title}')).toMatchObject({
      switchTo: '@markupReenter'
    })
    expect(findRuleAction('markupReenter', '<h1>Hello</h1>')).toMatchObject({
      switchTo: '@markup',
      nextEmbedded: 'html'
    })
  })

  // Regression: while the html embed is active, only parent rules whose action
  // pops the embed are consulted before delegating to html. The `markup`
  // state must wire `nextEmbedded: '@pop'` on the structural rules so a
  // trailing `<script>` or `<style>` after page markup can switch language.
  it('pops the html embed when later script/style/comment markers appear', () => {
    expect(findRuleAction('markup', '<script>', { embedPopOnly: true })).toMatchObject({
      switchTo: '@scriptOpen.javascript',
      nextEmbedded: '@pop'
    })
    expect(findRuleAction('markup', '<style lang="scss">', { embedPopOnly: true })).toMatchObject({
      switchTo: '@styleOpen.css',
      nextEmbedded: '@pop'
    })
    expect(findRuleAction('markup', '<!-- comment -->', { embedPopOnly: true })).toMatchObject({
      switchTo: '@comment',
      nextEmbedded: '@pop'
    })
    expect(findRuleAction('markup', '{title}', { embedPopOnly: true })).toMatchObject({
      switchTo: '@astroExpressionEnter',
      nextEmbedded: '@pop'
    })
  })
})

describe('astro embedded language attributes', () => {
  it('tracks embedded languages from Astro expressions and lang= attributes', () => {
    expect(findRuleAction('astroExpressionEnter', 'title }')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@astroExpression'
    })
    expect(findRuleAction('scriptLangValue.javascript', '"ts"')).toMatchObject({
      switchTo: '@scriptOpen.typescript'
    })
    expect(findRuleAction('scriptLangValue.typescript', '"js"')).toMatchObject({
      switchTo: '@scriptOpen.javascript'
    })
    expect(findRuleAction('scriptLangValue.javascript', 'ts')).toMatchObject({
      switchTo: '@scriptOpen.typescript'
    })
    expect(findRuleAction('styleLangValue.css', '"scss"')).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.css', "'sass'")).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.css', 'less')).toMatchObject({
      switchTo: '@styleOpen.less'
    })
    expect(findRuleAction('styleLangValue.scss', '"css"')).toMatchObject({
      switchTo: '@styleOpen.css'
    })
  })
})
