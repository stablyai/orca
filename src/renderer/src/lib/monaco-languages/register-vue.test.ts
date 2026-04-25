import { describe, expect, it, vi } from 'vitest'
import { registerVueLanguage, vueLanguageConfiguration, vueMonarchLanguage } from './register-vue'

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

function findRuleAction(state: string, source: string): MonarchAction | undefined {
  const tokenizer = vueMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const stateRules = tokenizer[state] ?? tokenizer[state.split('.')[0]]
  const matchedRule = stateRules.find((rule) => {
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

function collectFixtureRuleActions(source: string): {
  line: number
  state: string
  matched: string
  nextState?: string
  nextEmbedded?: string
  switchTo?: string
}[] {
  const ruleActions: {
    line: number
    state: string
    matched: string
    nextState?: string
    nextEmbedded?: string
    switchTo?: string
  }[] = []
  const tokenizer = vueMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const lines = source.split('\n')
  const checks: { line: number; state: string; pattern: string }[] = [
    { line: 1, state: 'root', pattern: '<template' },
    { line: 1, state: 'templateOpen', pattern: '>' },
    { line: 2, state: 'templateBody', pattern: '{{' },
    { line: 2, state: 'templateExpression', pattern: '}}' },
    { line: 3, state: 'templateBody', pattern: '</template>' },
    { line: 5, state: 'root', pattern: '<script' },
    { line: 5, state: 'scriptOpen.typescript', pattern: '>' },
    { line: 7, state: 'scriptBody.typescript', pattern: '</script>' },
    { line: 9, state: 'root', pattern: '<style' },
    { line: 9, state: 'styleOpen.css', pattern: '>' },
    { line: 11, state: 'styleBody.css', pattern: '</style>' }
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

    ruleActions.push({
      line: check.line,
      state: check.state,
      matched: check.pattern,
      nextState: actionObject?.next ? normalizeState(actionObject.next) : undefined,
      nextEmbedded: actionObject?.nextEmbedded,
      switchTo: actionObject?.switchTo ? normalizeState(actionObject.switchTo) : undefined
    })
  })

  return ruleActions
}

describe('registerVueLanguage', () => {
  it('registers the vue language, Monarch tokenizer, and configuration once', () => {
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

    registerVueLanguage(monacoMock as never)
    registerVueLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'vue',
      extensions: ['.vue'],
      aliases: ['Vue']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('vue', vueMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('vue', vueLanguageConfiguration)
  })

  it('captures Vue tokenizer transitions for a representative SFC fixture', () => {
    const fixture = `<template>
  <p>{{ message.toUpperCase() }}</p>
</template>

<script setup lang="ts">
const message = 'hello'
</script>

<style scoped>
p { color: rebeccapurple; }
</style>`

    const ruleActions = collectFixtureRuleActions(fixture)

    expect(ruleActions).toMatchInlineSnapshot(`
      [
        {
          "line": 1,
          "matched": "<template",
          "nextEmbedded": undefined,
          "nextState": "templateOpen",
          "state": "root",
          "switchTo": undefined,
        },
        {
          "line": 1,
          "matched": ">",
          "nextEmbedded": "html",
          "nextState": undefined,
          "state": "templateOpen",
          "switchTo": "templateBody",
        },
        {
          "line": 2,
          "matched": "{{",
          "nextEmbedded": "@pop",
          "nextState": "templateExpressionEnter",
          "state": "templateBody",
          "switchTo": undefined,
        },
        {
          "line": 2,
          "matched": "}}",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "templateExpression",
          "switchTo": undefined,
        },
        {
          "line": 3,
          "matched": "</template>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "templateBody",
          "switchTo": undefined,
        },
        {
          "line": 5,
          "matched": "<script",
          "nextEmbedded": undefined,
          "nextState": "scriptOpen.typescript",
          "state": "root",
          "switchTo": undefined,
        },
        {
          "line": 5,
          "matched": ">",
          "nextEmbedded": "$S2",
          "nextState": undefined,
          "state": "scriptOpen.typescript",
          "switchTo": "scriptBody.$S2",
        },
        {
          "line": 7,
          "matched": "</script>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "scriptBody.typescript",
          "switchTo": undefined,
        },
        {
          "line": 9,
          "matched": "<style",
          "nextEmbedded": undefined,
          "nextState": "styleOpen.css",
          "state": "root",
          "switchTo": undefined,
        },
        {
          "line": 9,
          "matched": ">",
          "nextEmbedded": "$S2",
          "nextState": undefined,
          "state": "styleOpen.css",
          "switchTo": "styleBody.$S2",
        },
        {
          "line": 11,
          "matched": "</style>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "styleBody.css",
          "switchTo": undefined,
        },
      ]
    `)
  })

  it('tracks embedded languages from Vue block attributes', () => {
    expect(findRuleAction('templateExpressionEnter', 'message }}')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@templateExpression'
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
  })
})
