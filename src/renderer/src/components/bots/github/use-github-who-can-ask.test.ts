// @vitest-environment happy-dom
// A GitHub state refresh that changes nothing must keep the picker's service, and so its open
// session (one list request, the exact lookups it already made).
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorGitHubState } from '../../../../../shared/connector-bot-github-contract'

let state: ConnectorGitHubState
vi.mock('@/lib/bot-github-state', () => ({
  useBotGitHubRead: () => ({ status: 'ready', github: state })
}))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => null }))
vi.mock('@/app-shell/chrome/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => false
}))

const { useGitHubWhoCanAsk } = await import('./use-github-who-can-ask')

// A fresh object every call, as each refresh hands over, with the same content.
const fresh = (): ConnectorGitHubState => ({
  installUrl: 'https://github.com/apps/orca/installations/new',
  account: { userId: '1', login: 'owner' },
  accounts: [
    { userId: '1', login: 'owner', installations: ['10'], defaultBotId: null },
    { userId: '3', login: 'owner-work', installations: ['11'], defaultBotId: null }
  ],
  installations: [
    { installationId: '10', accountLogin: 'owner', repositories: [{ fullName: 'owner/app' }] },
    { installationId: '11', accountLogin: 'acme', repositories: null }
  ],
  defaultBotId: null
})

describe('the GitHub Who can ask service', () => {
  it('survives a refresh with the same accounts and installations', () => {
    state = fresh()
    const { result, rerender } = renderHook(() => useGitHubWhoCanAsk('local', true, '10'))
    const before = result.current
    expect(before.otherOwnerIds).toEqual(['3'])
    state = fresh()
    rerender()
    expect(result.current).toBe(before)
  })

  it('is rebuilt when a linked account actually changes', () => {
    state = fresh()
    const { result, rerender } = renderHook(() => useGitHubWhoCanAsk('local', true, '10'))
    const before = result.current
    state = { ...fresh(), accounts: fresh().accounts?.slice(0, 1) }
    rerender()
    expect(result.current).not.toBe(before)
    expect(result.current.otherOwnerIds).toEqual([])
  })
})
