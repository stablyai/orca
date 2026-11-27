// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BotGitHubView } from '@/lib/bot-github-state'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useGhSignedOutHost } from './GhSignedOutLine'

const signedOut: BotGitHubView = {
  status: 'ready',
  github: {
    installUrl: 'https://github.com/apps/orca/installations/new',
    account: { userId: '1', login: 'owner' },
    installations: [],
    defaultBotId: null,
    gh: 'signed-out'
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only id and name.
const pairedServer = [
  { id: 'env_m4', name: 'm4 air' }
] as unknown as AppState['runtimeEnvironments']

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
})

describe('where gh is signed out', () => {
  it("names a paired web window's server, never the computer showing the page", () => {
    useAppStore.setState({ runtimeEnvironments: pairedServer })
    expect(renderHook(() => useGhSignedOutHost('local', signedOut)).result.current).toBe(
      'this computer'
    )
    Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
    expect(renderHook(() => useGhSignedOutHost('local', signedOut)).result.current).toBe('m4 air')
    expect(renderHook(() => useGhSignedOutHost('runtime:env_m4', signedOut)).result.current).toBe(
      'm4 air'
    )
  })
})
