import { describe, expect, it, vi } from 'vitest'
import {
  registerSvelteLanguage,
  svelteLanguageConfiguration,
  svelteMonarchLanguage
} from './register-svelte'

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
  const tokenizer = svelteMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const stateRules = tokenizer[state] ?? tokenizer[state.split('.')[0]]
  // When the html embed is active inside `markup`, Monaco's
  // `_findLeavingNestedLanguageOffset` only consults rules whose action has
  // `nextEmbedded: '@pop'` — the zero-width `@rematch` catch-all is
  // skipped. Mirror that when callers want to verify the "structural rule
  // pops the embed" path.
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
  const tokenizer = svelteMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const lines = source.split('\n')
  const checks: { line: number; state: string; pattern: string }[] = [
    { line: 1, state: 'root', pattern: '<script' },
    { line: 1, state: 'scriptOpen.typescript', pattern: '>' },
    { line: 4, state: 'scriptBody.typescript', pattern: '</script>' },
    // After </script> pops back to root and the next non-structural character
    // switches root -> markup with the html embed active.
    { line: 6, state: 'root', pattern: '' },
    { line: 7, state: 'markup', pattern: '{#if' },
    { line: 7, state: 'svelteBlockExpression', pattern: '}' },
    { line: 8, state: 'markup', pattern: '{' },
    { line: 8, state: 'svelteExpression', pattern: '}' },
    { line: 9, state: 'markup', pattern: '{:else' },
    { line: 9, state: 'svelteBlockExpressionEnter', pattern: '}' },
    { line: 11, state: 'markup', pattern: '{/if}' },
    { line: 13, state: 'markup', pattern: '{' },
    { line: 13, state: 'svelteExpression', pattern: '}' },
    { line: 14, state: 'markup', pattern: '{@html' },
    { line: 14, state: 'svelteExpression', pattern: '}' },
    { line: 16, state: 'markup', pattern: '<style' },
    { line: 16, state: 'styleOpen.css', pattern: '>' },
    { line: 18, state: 'styleBody.css', pattern: '</style>' }
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

describe('registerSvelteLanguage registration', () => {
  it('registers the svelte language, Monarch tokenizer, and configuration once', () => {
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

    registerSvelteLanguage(monacoMock as never)
    registerSvelteLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'svelte',
      extensions: ['.svelte'],
      aliases: ['Svelte']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('svelte', svelteMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('svelte', svelteLanguageConfiguration)
  })
})

describe('svelte tokenizer transitions', () => {
  it('captures Svelte tokenizer transitions for a representative SFC fixture', () => {
    const fixture = `<script lang="ts">
  let count = 0
  $: doubled = count * 2
</script>

<h1>Counter</h1>
{#if count > 0}
  <p>{count} clicked</p>
{:else}
  <p>not yet</p>
{/if}

<button on:click={increment}>{count}</button>
{@html '<em>raw</em>'}

<style>
  h1 { color: rebeccapurple; }
</style>`

    const ruleActions = collectFixtureRuleActions(fixture)

    expect(ruleActions).toMatchInlineSnapshot(`
      [
        "1:root:<script -> next=-, embedded=-, switch=scriptOpen.typescript",
        "1:scriptOpen.typescript:> -> next=-, embedded=$S2, switch=scriptBody.$S2",
        "4:scriptBody.typescript:</script> -> next=-, embedded=@pop, switch=markupReenter",
        "6:root:<html> -> next=-, embedded=html, switch=markup",
        "7:markup:{#if -> next=-, embedded=@pop, switch=svelteBlockExpressionEnter",
        "7:svelteBlockExpression:} -> next=-, embedded=@pop, switch=markupReenter",
        "8:markup:{ -> next=-, embedded=@pop, switch=svelteExpressionEnter",
        "8:svelteExpression:} -> next=-, embedded=@pop, switch=markupReenter",
        "9:markup:{:else -> next=-, embedded=@pop, switch=svelteBlockExpressionEnter",
        "9:svelteBlockExpressionEnter:} -> next=-, embedded=-, switch=markupReenter",
        "11:markup:{/if} -> next=-, embedded=-, switch=-",
        "13:markup:{ -> next=-, embedded=@pop, switch=svelteExpressionEnter",
        "13:svelteExpression:} -> next=-, embedded=@pop, switch=markupReenter",
        "14:markup:{@html -> next=-, embedded=@pop, switch=svelteExpressionEnter",
        "14:svelteExpression:} -> next=-, embedded=@pop, switch=markupReenter",
        "16:markup:<style -> next=-, embedded=@pop, switch=styleOpen.css",
        "16:styleOpen.css:> -> next=-, embedded=$S2, switch=styleBody.$S2",
        "18:styleBody.css:</style> -> next=-, embedded=@pop, switch=markupReenter",
      ]
    `)
  })
})

describe('svelte tokenizer regressions', () => {
  // Regression: when a Svelte file starts with `{#if}`, `{name}`, or `{@html}`,
  // no html embed is active yet. Earlier drafts unconditionally emitted
  // `nextEmbedded: '@pop'` from root, which Monaco rejects with
  // "cannot pop embedded language if not inside one". The fix splits the
  // entry-only `root` state from the html-embedded `markup` state.
  it('does not pop a non-existent embed when a file starts with a Svelte block', () => {
    const action = findRuleAction('root', '{#if foo}')
    expect(action).toMatchObject({ switchTo: '@svelteBlockExpressionEnter' })
    expect(action?.nextEmbedded).toBeUndefined()
  })

  it('starts the html embed and switches to markup when markup begins', () => {
    expect(findRuleAction('root', '<h1>Counter</h1>')).toMatchObject({
      switchTo: '@markup',
      nextEmbedded: 'html'
    })
  })

  // Regression: while the html embed is active, only parent rules whose action
  // pops the embed are consulted before delegating to html. The first draft
  // omitted `nextEmbedded: '@pop'` from `<script>` / `<style>` / `<!--` rules,
  // so a trailing `<style lang="scss">` after markup never reached the
  // lang-switching code. The `markup` state wires the embed pop in.
  it('pops the html embed when later script/style/comment markers appear', () => {
    expect(findRuleAction('markup', '<script lang="ts">', { embedPopOnly: true })).toMatchObject({
      switchTo: '@scriptOpen.typescript',
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
  })
})

describe('svelte embedded language attributes', () => {
  it('tracks embedded languages from Svelte block attributes and expressions', () => {
    expect(findRuleAction('svelteExpressionEnter', 'count }')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@svelteExpression'
    })
    expect(findRuleAction('svelteBlockExpressionEnter', 'count > 0}')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@svelteBlockExpression'
    })
    expect(findRuleAction('scriptLangValue.typescript', '"js"')).toMatchObject({
      switchTo: '@scriptOpen.javascript'
    })
    expect(findRuleAction('scriptLangValue.javascript', '"ts"')).toMatchObject({
      switchTo: '@scriptOpen.typescript'
    })
    expect(findRuleAction('scriptLangValue.typescript', 'js')).toMatchObject({
      switchTo: '@scriptOpen.javascript'
    })
    expect(findRuleAction('styleLangValue.css', '"scss"')).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.css', 'less')).toMatchObject({
      switchTo: '@styleOpen.less'
    })
    expect(findRuleAction('styleLangValue.css', "'sass'")).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.scss', '"css"')).toMatchObject({
      switchTo: '@styleOpen.css'
    })
  })
})
