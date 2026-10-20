import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from './rpc-contract/client-settings-params'
import {
  REPOSITORY_ADD_SCRIPT_MAX_LENGTH,
  normalizeRepositoryAddScriptUpdate,
  normalizeStoredRepositoryAddScript
} from './repository-add-script-settings'

describe('normalizeStoredRepositoryAddScript', () => {
  it('keeps valid text exactly, including shebang, hash lines and whitespace', () => {
    const script = '#!/bin/sh\n# note\n  echo "$ORCA"  \n\n'
    expect(normalizeStoredRepositoryAddScript(script)).toBe(script)
  })

  it('treats absent, empty and whitespace-only values as unconfigured', () => {
    expect(normalizeStoredRepositoryAddScript(undefined)).toBeUndefined()
    expect(normalizeStoredRepositoryAddScript('')).toBeUndefined()
    expect(normalizeStoredRepositoryAddScript(' \n\t')).toBeUndefined()
  })

  it('treats non-strings and oversized text as invalid', () => {
    expect(normalizeStoredRepositoryAddScript(42)).toBeNull()
    expect(normalizeStoredRepositoryAddScript(['echo'])).toBeNull()
    expect(normalizeStoredRepositoryAddScript(null)).toBeNull()
    expect(
      normalizeStoredRepositoryAddScript('x'.repeat(REPOSITORY_ADD_SCRIPT_MAX_LENGTH + 1))
    ).toBeNull()
    expect(
      normalizeStoredRepositoryAddScript('x'.repeat(REPOSITORY_ADD_SCRIPT_MAX_LENGTH))
    ).toHaveLength(REPOSITORY_ADD_SCRIPT_MAX_LENGTH)
  })
})

describe('normalizeRepositoryAddScriptUpdate', () => {
  it('returns exact valid text and undefined for a clearing write', () => {
    const script = '#!/bin/sh\n  echo hi \n'
    expect(normalizeRepositoryAddScriptUpdate(script)).toBe(script)
    expect(normalizeRepositoryAddScriptUpdate('')).toBeUndefined()
    expect(normalizeRepositoryAddScriptUpdate(' \n')).toBeUndefined()
    expect(normalizeRepositoryAddScriptUpdate(undefined)).toBeUndefined()
  })

  it('throws for a non-string or oversized write', () => {
    expect(() => normalizeRepositoryAddScriptUpdate(1)).toThrow()
    expect(() => normalizeRepositoryAddScriptUpdate(null)).toThrow()
    expect(() =>
      normalizeRepositoryAddScriptUpdate('x'.repeat(REPOSITORY_ADD_SCRIPT_MAX_LENGTH + 1))
    ).toThrow()
  })
})

describe('SettingsUpdate repositoryAddScript', () => {
  it('stays optional so older clients and unrelated updates are unchanged', () => {
    expect(SettingsUpdate.safeParse({ compactWorktreeCards: true }).success).toBe(true)
  })

  it('accepts exact text up to the bound and empty text to clear', () => {
    const script = '#!/bin/sh\n  echo hi \n'
    const parsed = SettingsUpdate.parse({ repositoryAddScript: script })
    expect(parsed.repositoryAddScript).toBe(script)
    expect(SettingsUpdate.safeParse({ repositoryAddScript: '' }).success).toBe(true)
  })

  it('rejects non-strings and oversized text', () => {
    expect(SettingsUpdate.safeParse({ repositoryAddScript: 1 }).success).toBe(false)
    expect(SettingsUpdate.safeParse({ repositoryAddScript: null }).success).toBe(false)
    expect(
      SettingsUpdate.safeParse({
        repositoryAddScript: 'x'.repeat(REPOSITORY_ADD_SCRIPT_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })
})
