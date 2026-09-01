import { describe, expect, it } from 'vitest'
import {
  normalizeStatusBarUsageFormat,
  resolveStatusBarUsageTemplate
} from './status-bar-usage-format'

describe('normalizeStatusBarUsageFormat', () => {
  it('returns an empty template for missing or malformed values', () => {
    expect(normalizeStatusBarUsageFormat(undefined)).toEqual({ template: '' })
    expect(normalizeStatusBarUsageFormat('not-an-object')).toEqual({ template: '' })
    expect(normalizeStatusBarUsageFormat({ template: 42 })).toEqual({ template: '' })
  })

  it('keeps a shared template and only known provider overrides', () => {
    expect(
      normalizeStatusBarUsageFormat({
        template: '{provider} {5h}',
        byProvider: { codex: '{plan} {5h}', bogus: 'x', claude: 7 }
      })
    ).toEqual({ template: '{provider} {5h}', byProvider: { codex: '{plan} {5h}' } })
  })

  it('drops an empty byProvider map', () => {
    expect(normalizeStatusBarUsageFormat({ template: 'a', byProvider: {} })).toEqual({
      template: 'a'
    })
  })
})

describe('resolveStatusBarUsageTemplate', () => {
  it('prefers a provider override, then the shared template, then null', () => {
    const format = { template: 'shared', byProvider: { codex: 'codex-only' } }
    expect(resolveStatusBarUsageTemplate(format, 'codex')).toBe('codex-only')
    expect(resolveStatusBarUsageTemplate(format, 'claude')).toBe('shared')
    expect(resolveStatusBarUsageTemplate({ template: '   ' }, 'claude')).toBeNull()
    expect(resolveStatusBarUsageTemplate(undefined, 'claude')).toBeNull()
  })
})
