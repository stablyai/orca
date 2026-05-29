import { describe, expect, it, vi } from 'vitest'
import {
  batchLanguageConfiguration,
  batchMonarchLanguage,
  registerBatchLanguage
} from './register-batch'

type MonarchCasesAction = {
  cases: Record<string, string>
}
type MonarchRule = [RegExp, string | MonarchCasesAction] | { include: string }

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchCasesAction] {
  return Array.isArray(rule)
}

function resolveActionToken(action: string | MonarchCasesAction, value: string): string {
  if (typeof action === 'string') {
    return action
  }

  const keywords = batchMonarchLanguage.keywords ?? []
  if (keywords.includes(value.toLowerCase())) {
    return action.cases['@keywords']
  }

  return action.cases['@default']
}

function firstTokenFor(source: string): string | undefined {
  const tokenizer = batchMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const matchedRule = tokenizer.root.find((rule) => {
    if (!isRuleEntry(rule)) {
      return false
    }

    const [regexp] = rule
    regexp.lastIndex = 0
    const match = regexp.exec(source)
    return match !== null && match.index === 0
  })

  if (!matchedRule || !isRuleEntry(matchedRule)) {
    return undefined
  }

  const [regexp, action] = matchedRule
  regexp.lastIndex = 0
  const match = regexp.exec(source)
  return match ? resolveActionToken(action, match[0]) : undefined
}

describe('registerBatchLanguage registration', () => {
  it('registers the batch language, Monarch tokenizer, and configuration once', () => {
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

    registerBatchLanguage(monacoMock as never)
    registerBatchLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'batch',
      extensions: ['.bat', '.cmd'],
      aliases: ['Batch', 'Windows Batch']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('batch', batchMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('batch', batchLanguageConfiguration)
  })
})

describe('batch tokenizer rules', () => {
  it('recognizes common line-level comments and labels before command parsing', () => {
    expect(firstTokenFor('rem install dependencies')).toBe('comment')
    expect(firstTokenFor('@REM install dependencies')).toBe('comment')
    expect(firstTokenFor(':: install dependencies')).toBe('comment')
    expect(firstTokenFor(':retry')).toBe('type.identifier')
  })

  it('recognizes core Batch commands and control-flow keywords', () => {
    expect(firstTokenFor('@echo off')).toBe('keyword')
    expect(firstTokenFor('if exist package.json echo found')).toBe('keyword')
    expect(firstTokenFor('for %%F in (*.cmd) do call :run')).toBe('keyword')
    expect(firstTokenFor('goto :retry')).toBe('keyword')
    expect(firstTokenFor('call :run')).toBe('keyword')
  })

  it('recognizes Batch variable expansion forms', () => {
    expect(firstTokenFor('%PATH%')).toBe('variable')
    expect(firstTokenFor('!ERRORLEVEL!')).toBe('variable')
    expect(firstTokenFor('%~dp0')).toBe('variable.predefined')
    expect(firstTokenFor('%~f0')).toBe('variable.predefined')
    expect(firstTokenFor('%%F')).toBe('variable')
  })

  it('recognizes strings, escapes, and command operators', () => {
    expect(firstTokenFor('"C:\\Program Files\\Orca"')).toBe('string')
    expect(firstTokenFor('^|')).toBe('string.escape')
    expect(firstTokenFor('&& echo done')).toBe('operator')
    expect(firstTokenFor('>> output.log')).toBe('operator')
  })
})
