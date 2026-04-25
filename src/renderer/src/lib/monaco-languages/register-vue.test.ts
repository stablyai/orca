import { describe, expect, it, vi } from 'vitest'
import { registerVueLanguage, vueLanguageConfiguration, vueMonarchLanguage } from './register-vue'

type MonarchRule = [RegExp, unknown, string?]

function normalizeState(nextState: string): string {
  return nextState.startsWith('@') ? nextState.slice(1) : nextState
}

function collectFixtureRuleActions(source: string): {
  line: number
  state: string
  matched: string
  nextState?: string
  nextEmbedded?: string
}[] {
  const ruleActions: {
    line: number
    state: string
    matched: string
    nextState?: string
    nextEmbedded?: string
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
    { line: 5, state: 'scriptOpen', pattern: '>' },
    { line: 7, state: 'scriptBody', pattern: '</script>' },
    { line: 9, state: 'root', pattern: '<style' },
    { line: 9, state: 'styleOpen', pattern: '>' },
    { line: 11, state: 'styleBody', pattern: '</style>' }
  ]

  checks.forEach((check) => {
    const line = lines.at(check.line - 1) ?? ''
    const stateRules = tokenizer[check.state]
    const matchedRule = stateRules.find(([regexp]) => {
      regexp.lastIndex = 0
      const match = regexp.exec(line)
      return match !== null && match[0] === check.pattern
    })
    if (!matchedRule) {
      return
    }

    const [, action, nextStateShortcut] = matchedRule
    const actionObject =
      typeof action === 'object'
        ? (action as { next?: string; nextEmbedded?: string })
        : nextStateShortcut
          ? { next: nextStateShortcut }
          : undefined

    ruleActions.push({
      line: check.line,
      state: check.state,
      matched: check.pattern,
      nextState: actionObject?.next ? normalizeState(actionObject.next) : undefined,
      nextEmbedded: actionObject?.nextEmbedded
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
        },
        {
          "line": 1,
          "matched": ">",
          "nextEmbedded": "html",
          "nextState": "templateBody",
          "state": "templateOpen",
        },
        {
          "line": 2,
          "matched": "{{",
          "nextEmbedded": "@pop",
          "nextState": "templateExpression",
          "state": "templateBody",
        },
        {
          "line": 2,
          "matched": "}}",
          "nextEmbedded": "html",
          "nextState": "pop",
          "state": "templateExpression",
        },
        {
          "line": 3,
          "matched": "</template>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "templateBody",
        },
        {
          "line": 5,
          "matched": "<script",
          "nextEmbedded": undefined,
          "nextState": "scriptOpen",
          "state": "root",
        },
        {
          "line": 5,
          "matched": ">",
          "nextEmbedded": "typescript",
          "nextState": "scriptBody",
          "state": "scriptOpen",
        },
        {
          "line": 7,
          "matched": "</script>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "scriptBody",
        },
        {
          "line": 9,
          "matched": "<style",
          "nextEmbedded": undefined,
          "nextState": "styleOpen",
          "state": "root",
        },
        {
          "line": 9,
          "matched": ">",
          "nextEmbedded": "css",
          "nextState": "styleBody",
          "state": "styleOpen",
        },
        {
          "line": 11,
          "matched": "</style>",
          "nextEmbedded": "@pop",
          "nextState": "pop",
          "state": "styleBody",
        },
      ]
    `)
  })
})
