import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
  glimmerJsMonarchLanguage,
  glimmerLanguageConfiguration,
  glimmerTsMonarchLanguage,
  registerGlimmerLanguages
} from './register-glimmer'

type MonarchAction = {
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

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
  language: Monaco.languages.IMonarchLanguage,
  state: string,
  source: string
): MonarchAction | undefined {
  const tokenizer = language.tokenizer as Record<string, MonarchRule[]>
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

describe('glimmer Monarch tokenizer', () => {
  it('carries distinct base embeds and token postfixes per variant', () => {
    expect(glimmerTsMonarchLanguage.tokenPostfix).toBe('.gts')
    expect(glimmerJsMonarchLanguage.tokenPostfix).toBe('.gjs')
    expect(findRuleAction(glimmerTsMonarchLanguage, 'scriptReenter', 'const x = 1')).toMatchObject({
      switchTo: '@script',
      nextEmbedded: 'typescript'
    })
    expect(findRuleAction(glimmerJsMonarchLanguage, 'scriptReenter', 'const x = 1')).toMatchObject({
      switchTo: '@script',
      nextEmbedded: 'javascript'
    })
  })

  it('enters the handlebars template island and returns to the script background', () => {
    const fixture = `export default class Hello extends Component {
  name = 'world'
  <template>
    <p>Hello {{this.name}}</p>
  </template>
}`
    const lines = fixture.split('\n')

    expect(findRuleAction(glimmerTsMonarchLanguage, 'script', lines[2].trimStart())).toMatchObject({
      switchTo: '@templateEnter',
      nextEmbedded: '@pop'
    })
    expect(findRuleAction(glimmerTsMonarchLanguage, 'templateEnter', '<p>')).toMatchObject({
      switchTo: '@templateBody',
      nextEmbedded: 'handlebars'
    })
    expect(
      findRuleAction(glimmerTsMonarchLanguage, 'templateBody', lines[4].trimStart())
    ).toMatchObject({
      switchTo: '@scriptReenter',
      nextEmbedded: '@pop'
    })
  })

  it('supports a top-level template-only component from file start', () => {
    // `.gjs` template-only component: `<template>` is the very first token.
    expect(findRuleAction(glimmerJsMonarchLanguage, 'root', '<template>')).toMatchObject({
      switchTo: '@scriptReenter'
    })
    expect(findRuleAction(glimmerJsMonarchLanguage, 'script', '<template>')).toMatchObject({
      switchTo: '@templateEnter',
      nextEmbedded: '@pop'
    })
  })
})

describe('registerGlimmerLanguages', () => {
  it('registers both Glimmer languages, tokenizers, and configuration once', () => {
    const languages: { id: string }[] = [
      { id: 'typescript' },
      { id: 'javascript' },
      { id: 'handlebars' }
    ]
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

    registerGlimmerLanguages(monacoMock as never)
    registerGlimmerLanguages(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith({
      id: 'glimmer-ts',
      extensions: ['.gts'],
      aliases: ['Glimmer TS']
    })
    expect(register).toHaveBeenCalledWith({
      id: 'glimmer-js',
      extensions: ['.gjs'],
      aliases: ['Glimmer JS']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('glimmer-ts', glimmerTsMonarchLanguage)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('glimmer-js', glimmerJsMonarchLanguage)
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(2)
    expect(setLanguageConfiguration).toHaveBeenCalledWith(
      'glimmer-ts',
      glimmerLanguageConfiguration
    )
    expect(setLanguageConfiguration).toHaveBeenCalledWith(
      'glimmer-js',
      glimmerLanguageConfiguration
    )
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(2)
  })
})
