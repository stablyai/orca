// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentLaunchVaultResumeCopyResult } from '../../../../shared/agent-launch-spawn-request'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const resumeCommandMock = vi.fn<(entry: unknown) => Promise<AgentLaunchVaultResumeCopyResult>>()
const writeClipboardMock = vi.fn<(text: string) => Promise<void>>()

const baseSession: AiVaultSession = {
  id: 'claude:1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Implement project history',
  cwd: '/Users/ada/orca',
  branch: 'feature/history',
  model: 'claude-sonnet-4-5',
  filePath: '/Users/ada/.claude/projects/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "cd '/Users/ada/orca' && claude --resume 'session-1'",
  subagent: null
}

const emptyTargetState: AiVaultSessionResumeTargetState = {
  folderWorkspaces: [],
  projectGroups: [],
  repos: [],
  worktreesByRepo: {}
}

const roots: Root[] = []
let actions: ReturnType<typeof useAiVaultSessionLaunchActions> | null = null

function HookProbe(): null {
  actions = useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: 'wt-1',
    targetState: emptyTargetState
  })
  return null
}

async function renderHook(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
}

beforeEach(() => {
  resumeCommandMock.mockReset()
  writeClipboardMock.mockReset().mockResolvedValue(undefined)
  toastSuccess.mockClear()
  toastError.mockClear()
  actions = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: { resumeCommand: resumeCommandMock },
    ui: { writeClipboardText: writeClipboardMock }
  }
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('useAiVaultSessionLaunchActions copyResumeCommand', () => {
  it('echoes the discovered entry to the host copy IPC and writes the returned command', async () => {
    resumeCommandMock.mockResolvedValue({ status: 'ok', command: "claude --resume 'session-1'" })
    await renderHook()

    await act(async () => {
      await actions?.copyResumeCommand(baseSession)
    })

    // Host owns assembly; the client only echoes the discovered identity (filePath
    // rides the trusted desktop IPC) and copies the returned string.
    expect(resumeCommandMock).toHaveBeenCalledWith(
      {
        executionHostId: 'local',
        agent: 'claude',
        sessionId: 'session-1',
        filePath: '/Users/ada/.claude/projects/session-1.jsonl'
      },
      // Quoting follows the workspace the command is pasted into, not the host;
      // this local workspace resolves to the client platform.
      'linux'
    )
    expect(writeClipboardMock).toHaveBeenCalledWith("claude --resume 'session-1'")
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('surfaces the unavailable message without copying when the host rejects the entry', async () => {
    resumeCommandMock.mockResolvedValue({
      status: 'failed',
      failure: { code: 'invalid_launch_snapshot' }
    })
    await renderHook()

    await act(async () => {
      await actions?.copyResumeCommand(baseSession)
    })

    expect(writeClipboardMock).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
