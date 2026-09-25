// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultProjectSuggestions } from './AiVaultProjectSuggestions'

const store = vi.hoisted(() => ({
  state: {
    repos: [],
    settings: { dismissedSessionProjectSuggestions: [] },
    updateSettings: vi.fn(async () => {}),
    addRepoPath: vi.fn(async (): Promise<{ id: string } | null> => null)
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

const suggestProjects = vi.fn()

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:s1:/tmp/s1.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 's1',
    title: 'Session',
    cwd: '/home/me/Projects/app',
    branch: null,
    model: null,
    filePath: '/tmp/s1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-25T10:00:00.000Z',
    messageCount: 3,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume s1',
    subagent: null,
    ...overrides
  }
}

beforeEach(() => {
  suggestProjects.mockReset()
  store.state.addRepoPath.mockClear()
  store.state.updateSettings.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { suggestProjects } }
  })
})

afterEach(() => {
  cleanup()
})

describe('AiVaultProjectSuggestions', () => {
  it('sends only local, non-subagent session folders', async () => {
    suggestProjects.mockResolvedValue([])
    render(
      <AiVaultProjectSuggestions
        sessions={[
          makeSession(),
          makeSession({ id: 'remote', executionHostId: 'ssh:box' }),
          makeSession({
            id: 'child',
            subagent: { parentSessionId: 's1', agentType: null, status: 'completed' }
          }),
          makeSession({ id: 'no-cwd', cwd: null })
        ]}
      />
    )

    await waitFor(() => expect(suggestProjects).toHaveBeenCalledOnce())
    expect(suggestProjects).toHaveBeenCalledWith({
      sources: [{ cwd: '/home/me/Projects/app', agent: 'claude' }]
    })
  })

  it('renders nothing when there is nothing to suggest', async () => {
    suggestProjects.mockResolvedValue([])
    const { container } = render(<AiVaultProjectSuggestions sessions={[makeSession()]} />)

    await waitFor(() => expect(suggestProjects).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('adds only the checked suggestions', async () => {
    suggestProjects.mockResolvedValue([
      { path: '/home/me/Projects/app', name: 'app', sessionCount: 3, agents: ['claude', 'codex'] },
      { path: '/home/me/Projects/web', name: 'web', sessionCount: 1, agents: ['codex'] }
    ])
    render(<AiVaultProjectSuggestions sessions={[makeSession()]} />)

    expect(await screen.findByText('2 projects found in your recent agent sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'web' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 project' }))

    await waitFor(() => expect(store.state.addRepoPath).toHaveBeenCalledOnce())
    expect(store.state.addRepoPath).toHaveBeenCalledWith('/home/me/Projects/app', 'git', {
      runtimeEnvironmentId: null
    })
  })

  it('keeps adding after one project fails and names the failure', async () => {
    suggestProjects.mockResolvedValue([
      { path: '/home/me/Projects/app', name: 'app', sessionCount: 3, agents: ['claude'] },
      { path: '/home/me/Projects/web', name: 'web', sessionCount: 1, agents: ['codex'] }
    ])
    store.state.addRepoPath
      .mockRejectedValueOnce(new Error('not a repo'))
      .mockResolvedValueOnce({ id: 'web' })
    render(<AiVaultProjectSuggestions sessions={[makeSession()]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add 2 projects' }))

    expect(await screen.findByText("Couldn't add: app")).toBeTruthy()
    expect(store.state.addRepoPath).toHaveBeenCalledTimes(2)
  })

  it('remembers dismissed suggestions in settings', async () => {
    suggestProjects.mockResolvedValue([
      { path: '/home/me/Projects/app', name: 'app', sessionCount: 3, agents: ['claude'] }
    ])
    render(<AiVaultProjectSuggestions sessions={[makeSession()]} />)

    fireEvent.click(await screen.findByRole('button', { name: "Don't suggest these" }))

    await waitFor(() =>
      expect(store.state.updateSettings).toHaveBeenCalledWith({
        dismissedSessionProjectSuggestions: ['/home/me/Projects/app']
      })
    )
  })
})
