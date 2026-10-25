import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { resolveBackendDraftStartup } from './worktree-draft-startup-view-mode'

type AppState = ReturnType<typeof useAppStore.getState>

const initialSettings = useAppStore.getState().settings!
const initialRepos = useAppStore.getState().repos

const request = {
  repoId: 'repo-1',
  startup: { launchCommand: 'omp' },
  launchDraftPrompt: 'https://github.com/o/r/issues/12'
} as never

function setRepoConnection(connectionId: string | null): void {
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId }]
  } as unknown as Partial<AppState>)
}

function viewModeFor(agent: string): string | undefined {
  const startup = resolveBackendDraftStartup({ ...(request as object), agent } as never) as
    | { viewMode?: string }
    | undefined
  return startup?.viewMode
}

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...initialSettings,
      experimentalNativeChat: true
    }
  })
})

afterEach(() => {
  useAppStore.setState({ settings: initialSettings, repos: initialRepos } as Partial<AppState>)
})

describe('resolveBackendDraftStartup', () => {
  it('keeps a local omp terminal startup in terminal view', () => {
    setRepoConnection(null)
    expect(viewModeFor('omp')).toBe('terminal')
  })

  it('keeps a Model-A SSH omp draft in the terminal view', () => {
    setRepoConnection('ssh-target-1')
    expect(viewModeFor('omp')).toBe('terminal')
  })

  it('keeps a runtime-owned SSH omp terminal startup in terminal view', () => {
    setRepoConnection('runtime-ssh-env-1')
    expect(viewModeFor('omp')).toBe('terminal')
  })
})
