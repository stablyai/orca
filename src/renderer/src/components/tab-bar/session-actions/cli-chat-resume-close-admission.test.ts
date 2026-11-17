// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  admission: vi.fn(),
  openMove: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: vi.fn(), dismiss: vi.fn(), success: vi.fn() }
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: async () => true
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-host-admission', () => ({
  admitStructuredLaunchOnHost: mocks.admission
}))
vi.mock('@/components/wsl-move/wsl-move-entry', () => ({ openWslMoveDialogFor: mocks.openMove }))

import { useAppStore } from '@/store/index'
import { admitCliChatResumeClose } from './cli-chat-resume-close-admission'
import { makeRepo } from '../../worktree-jump/worktree-jump-palette-test-fixtures'

const REPO_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const WORKTREE_ID = `repo-1::${REPO_PATH}`

const source = {
  tabId: 'term-1',
  workspaceId: WORKTREE_ID,
  paneKey: 'term-1:11111111-1111-4111-8111-111111111111',
  agent: 'claude',
  providerSessionId: 'provider-1',
  executionHostId: 'local'
} as const

function admit(): Promise<unknown> {
  return admitCliChatResumeClose(
    source,
    'claude',
    { kind: 'local' },
    false,
    () => true,
    new AbortController().signal
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    repos: [{ ...makeRepo(), id: 'repo-1', path: REPO_PATH }],
    wslHostsAcceptNewWork: true,
    wslHostServerFiles: 'present'
  })
  vi.stubGlobal('window', { ...window, api: { runtimeEnvironments: { wslHosts: {} } } })
  mocks.admission.mockResolvedValue({ kind: 'declined', reason: 'wsl' })
})

describe('resuming a WSL terminal conversation in chat', () => {
  it('offers the WSL host path on the refusal toast', async () => {
    expect(await admit()).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('Run the project on a WSL host'),
      { action: { label: 'Run Ubuntu as a host', onClick: expect.any(Function) } }
    )
  })

  it('keeps the plain toast where WSL hosts cannot be added', async () => {
    useAppStore.setState({ wslHostsAcceptNewWork: false })
    await admit()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Chat is not available in WSL. Open the agent in a terminal instead.',
      undefined
    )
  })
})
