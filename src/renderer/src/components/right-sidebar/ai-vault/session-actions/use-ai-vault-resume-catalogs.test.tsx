// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../session-list/AiVaultSessionSurfaceSwitchMenuItems'
import { useAiVaultPanelSessionResume } from './use-ai-vault-panel-session-resume'
import { useAiVaultResumeCatalogs } from './use-ai-vault-resume-catalogs'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))

const initial = useAppStore.getInitialState()
const localWorkspace = makeWorktree('local-workspace', 'Local', { path: '/repo/local' })
const pairedWorkspace = makeWorktree('paired-workspace', 'Old server', {
  repoId: 'paired-repo',
  path: '/srv/remote',
  hostId: 'runtime:old-server'
})
const session: AiVaultSession = {
  id: 'local:opencode:session-1',
  executionHostId: 'local',
  agent: 'opencode',
  sessionId: 'session-1',
  title: 'Task',
  cwd: '/repo/local',
  branch: null,
  model: null,
  filePath: '/home/test/.local/share/opencode/session/session-1.json',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-11-09T12:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'user', text: 'Continue this task', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'opencode --session session-1',
  subagent: null
}
const sessions = [session]
const worktrees = [localWorkspace, pairedWorkspace]

function HistoryActions({
  acquire,
  onResume
}: {
  acquire: boolean
  onResume: (id: string) => void
}) {
  const state = useAppStore.getState()
  const resume = useAiVaultPanelSessionResume({
    sessions,
    repos: state.repos,
    allWorktrees: worktrees,
    workspaceId: 'paired-workspace',
    resumeTargetState: state
  })
  const target = resume.getSessionResumeInChat(session)
  return (
    <>
      {acquire ? <HistoryCatalog /> : null}
      <DropdownMenu open>
        <DropdownMenuTrigger>Session actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AiVaultSessionSurfaceSwitchMenuItems
            action="resume"
            menuKind="dropdown"
            tooltipSide="left"
            onResumeInNewChat={target.available ? () => onResume(target.workspaceId) : undefined}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

function HistoryCatalog() {
  useAiVaultResumeCatalogs('local')
  return null
}

beforeEach(() => {
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests([
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
  ])
  useAppStore.setState({
    ...initial,
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      nativeChatProviders: {}
    }),
    repos: [
      { ...makeRepo(), path: '/repo', displayName: 'Local' },
      { ...makeRepo(), id: 'paired-repo', path: '/srv', executionHostId: 'runtime:old-server' }
    ],
    worktreesByRepo: { 'repo-1': [localWorkspace], 'paired-repo': [pairedWorkspace] },
    activeWorktreeId: 'paired-workspace',
    activeWorkspaceExecutionHostId: 'runtime:old-server'
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  vi.clearAllMocks()
})

it('offers cold local History resume in its own workspace while an old paired workspace is active', async () => {
  let answer!: (value: unknown) => void
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  const onResume = vi.fn()
  const view = render(<HistoryActions acquire={false} onResume={onResume} />)
  expect(screen.queryByRole('menuitem', { name: 'Resume in New Chat' })).toBeNull()

  view.rerender(<HistoryActions acquire onResume={onResume} />)
  await act(async () => {
    await Promise.resolve()
    answer({ agents: [{ agent: 'opencode', capabilities: {} }] })
  })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Resume in New Chat' }))
  expect(onResume).toHaveBeenCalledWith('local-workspace')
})
