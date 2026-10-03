import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import { sanitizeRepoUpdate } from './repo-update'

describe('sanitizeRepoUpdate terminalTheme', () => {
  it('normalizes a valid override', () => {
    expect(
      sanitizeRepoUpdate({ terminalTheme: { dark: ' Dracula ', light: 'custom:ghostty:abc' } })
    ).toEqual({ terminalTheme: { dark: 'Dracula', light: 'custom:ghostty:abc' } })
  })

  it('keeps null as the clear sentinel', () => {
    expect(sanitizeRepoUpdate({ terminalTheme: null })).toEqual({ terminalTheme: null })
  })

  it('drops a malformed override without touching other fields', () => {
    const garbage = JSON.parse('{"dark":5}')
    expect(sanitizeRepoUpdate({ displayName: 'x', terminalTheme: garbage })).toEqual({
      displayName: 'x'
    })
  })

  it('drops an override with no usable variant', () => {
    expect(sanitizeRepoUpdate({ terminalTheme: { dark: '  ' } })).toEqual({})
  })
})

describe('updateRepo when the main store refuses the write (null reply)', () => {
  const repo: Repo = {
    id: 'local-repo',
    path: '/local',
    displayName: 'Local',
    badgeColor: '#000',
    addedAt: 1,
    terminalTheme: { dark: 'Dracula' }
  }
  const reposUpdate = vi.fn()

  beforeEach(() => {
    reposUpdate.mockReset()
    vi.stubGlobal('window', { api: { repos: { update: reposUpdate } } })
  })

  it('does not apply a terminalTheme change and reports failure', async () => {
    reposUpdate.mockResolvedValue(null)
    const store = createTestStore()
    store.setState({ repos: [repo] })

    const ok = await store.getState().updateRepo(repo.id, { terminalTheme: { light: 'Solarized' } })

    expect(ok).toBe(false)
    expect(store.getState().repos[0]).toBe(repo)
  })

  it('does not apply a terminalTheme clear either', async () => {
    reposUpdate.mockResolvedValue(null)
    const store = createTestStore()
    store.setState({ repos: [repo] })

    expect(await store.getState().updateRepo(repo.id, { terminalTheme: null })).toBe(false)
    expect(store.getState().repos[0]?.terminalTheme).toEqual({ dark: 'Dracula' })
  })

  it('keeps merging other fields locally on a null reply', async () => {
    reposUpdate.mockResolvedValue(null)
    const store = createTestStore()
    store.setState({ repos: [repo] })

    expect(await store.getState().updateRepo(repo.id, { displayName: 'Renamed' })).toBe(true)
    expect(store.getState().repos[0]).toMatchObject({
      displayName: 'Renamed',
      terminalTheme: { dark: 'Dracula' }
    })
  })

  it('applies the stored row when the write succeeds', async () => {
    reposUpdate.mockResolvedValue({ ...repo, terminalTheme: { light: 'Solarized' } })
    const store = createTestStore()
    store.setState({ repos: [repo] })

    expect(
      await store.getState().updateRepo(repo.id, { terminalTheme: { light: 'Solarized' } })
    ).toBe(true)
    expect(store.getState().repos[0]?.terminalTheme).toEqual({ light: 'Solarized' })
  })
})
