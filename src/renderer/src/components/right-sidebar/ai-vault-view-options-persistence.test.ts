import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import {
  AI_VAULT_VIEW_OPTIONS_STORAGE_KEY,
  createDefaultAiVaultViewOptions,
  enabledAiVaultAgents,
  normalizeAiVaultViewOptions,
  readAiVaultViewOptions,
  writeAiVaultViewOptions
} from './ai-vault-view-options-persistence'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AI Vault view option persistence', () => {
  it('uses the documented defaults when no stored value exists', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }

    expect(readAiVaultViewOptions(storage)).toEqual(createDefaultAiVaultViewOptions())
  })

  it('normalizes malformed fields and removes unknown or duplicate agents', () => {
    expect(
      normalizeAiVaultViewOptions({
        disabledAgents: ['codex', 'unknown', 'codex', 7],
        sort: 'invalid',
        group: 'agent',
        hideEmptySessions: 'yes'
      })
    ).toEqual({
      disabledAgents: ['codex'],
      sort: 'updated',
      group: 'agent',
      hideEmptySessions: false
    })
  })

  it('preserves every valid sort, group, and boolean value', () => {
    expect(
      normalizeAiVaultViewOptions({
        disabledAgents: [],
        sort: 'updated',
        group: 'project',
        hideEmptySessions: false
      })
    ).toEqual({
      disabledAgents: [],
      sort: 'updated',
      group: 'project',
      hideEmptySessions: false
    })
    expect(
      normalizeAiVaultViewOptions({
        disabledAgents: [],
        sort: 'created',
        group: 'folder',
        hideEmptySessions: true
      })
    ).toEqual({
      disabledAgents: [],
      sort: 'created',
      group: 'folder',
      hideEmptySessions: true
    })
    expect(normalizeAiVaultViewOptions({ group: 'agent' }).group).toBe('agent')
  })

  it('falls back to all enabled when stored state disables the whole catalog', () => {
    const normalized = normalizeAiVaultViewOptions({
      disabledAgents: [...AI_VAULT_AGENTS],
      sort: 'created',
      group: 'folder',
      hideEmptySessions: true
    })

    expect(normalized.disabledAgents).toEqual([])
    expect(enabledAiVaultAgents(normalized.disabledAgents)).toEqual([...AI_VAULT_AGENTS])
  })

  it('falls back safely when JSON or storage access is unavailable', () => {
    const malformed = { getItem: vi.fn(() => '{not-json'), setItem: vi.fn() }
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      setItem: vi.fn()
    }

    expect(readAiVaultViewOptions(malformed)).toEqual(createDefaultAiVaultViewOptions())
    expect(readAiVaultViewOptions(unavailable)).toEqual(createDefaultAiVaultViewOptions())
    expect(readAiVaultViewOptions(null)).toEqual(createDefaultAiVaultViewOptions())
  })

  it('falls back when the renderer storage getter is blocked', () => {
    const blockedWindow = {}
    Object.defineProperty(blockedWindow, 'localStorage', {
      get: () => {
        throw new Error('blocked')
      }
    })
    vi.stubGlobal('window', blockedWindow)

    expect(readAiVaultViewOptions()).toEqual(createDefaultAiVaultViewOptions())
    expect(writeAiVaultViewOptions(createDefaultAiVaultViewOptions())).toBe(false)
  })

  it('writes a normalized, versioned per-client value', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }

    expect(
      writeAiVaultViewOptions(
        {
          disabledAgents: ['codex'],
          sort: 'created',
          group: 'folder',
          hideEmptySessions: true
        },
        storage
      )
    ).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(
      AI_VAULT_VIEW_OPTIONS_STORAGE_KEY,
      JSON.stringify({
        disabledAgents: ['codex'],
        sort: 'created',
        group: 'folder',
        hideEmptySessions: true
      })
    )
  })

  it('reports failed storage writes without throwing', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('quota exceeded')
      })
    }

    expect(writeAiVaultViewOptions(createDefaultAiVaultViewOptions(), storage)).toBe(false)
  })
})
