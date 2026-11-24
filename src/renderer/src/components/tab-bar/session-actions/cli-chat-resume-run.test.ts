import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CREATE_CLOSING_PANES_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import type {
  ProvisionalLaunchArgs,
  StructuredAgentSessionProvisionalLaunch
} from '@/lib/agent-session/structured-agent-session-provisional-tab'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import type { CliChatResumeSource } from './cli-chat-resume-source'

const REMOTE_HOST_ID = toRuntimeExecutionHostId('mac-host')
const FOLDER_WORKSPACE_ID = 'folder:ext-vol'
const SOURCE: CliChatResumeSource = {
  tabId: 'term-tab-1',
  workspaceId: FOLDER_WORKSPACE_ID,
  paneKey: 'term-tab-1:leaf-1',
  agent: 'claude',
  providerSessionId: 'provider-session-1',
  executionHostId: REMOTE_HOST_ID
}

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  closeCliChatResumeTerminal: vi.fn(),
  beginStructuredAgentSessionProvisionalLaunch:
    vi.fn<(args: ProvisionalLaunchArgs) => StructuredAgentSessionProvisionalLaunch | null>(),
  admitStructuredLaunchOnHost: vi.fn(),
  structuredAgentSessionHostSupports:
    vi.fn<(target: RuntimeClientTarget, capability: RuntimeCapability) => Promise<boolean>>(),
  supportsStructuredAgentSessionCreateMessage: vi.fn(),
  supportsStructuredAgentSessionCliSource: vi.fn(),
  readStructuredChatHostPermissionVerdict: vi.fn(),
  probePtyRunningWork: vi.fn(),
  adoptingAgentOnHost: vi.fn(),
  resolveCliChatResumeSource: vi.fn(),
  reopenNativeChatCliForkOrigin: vi.fn(),
  storeState: {
    groupsByWorktree: {
      'folder:ext-vol': [{ id: 'group-1', tabOrder: ['term-tab-1'] }]
    },
    terminalLayoutsByTabId: {
      'term-tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } }
    },
    agentStatusByPaneKey: new Map(),
    unifiedTabsByWorktree: {}
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key,
  i18n: { language: 'en', t: (key: string) => key }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.storeState,
    subscribe: () => () => undefined
  }
}))

vi.mock('@/store/slices/runtime-status/views/runtime-status-owner', () => ({
  readRuntimeStatuses: () => ({})
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  captureStructuredLaunchSurfaceAddress: () => ({
    worktreeId: FOLDER_WORKSPACE_ID,
    targetGroupId: 'group-1',
    precedingTabIds: []
  }),
  openStructuredAgentSessionProvisionalTab: vi.fn()
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-holders', () => ({
  structuredLaunchesHoldingIdentity: () => []
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  structuredLaunchIdentity: () => 'launch-identity-1'
}))

vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', () => ({
  adoptAgentSessionLaunchVerdict: (verdict: Record<string, unknown>) => ({
    ...verdict,
    begin: vi.fn()
  })
}))

vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-host-admission', () => ({
  admitStructuredLaunchOnHost: mocks.admitStructuredLaunchOnHost
}))

vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: mocks.structuredAgentSessionHostSupports,
  supportsStructuredAgentSessionCreateMessage: mocks.supportsStructuredAgentSessionCreateMessage,
  supportsStructuredAgentSessionCliSource: mocks.supportsStructuredAgentSessionCliSource
}))

vi.mock('@/runtime/native-chat/host-capabilities/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: mocks.readStructuredChatHostPermissionVerdict
}))

vi.mock('../../terminal/tab-lifecycle/pty-running-work-probe', () => ({
  probePtyRunningWork: mocks.probePtyRunningWork
}))

vi.mock(
  '../../right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch',
  () => ({
    adoptingAgentOnHost: mocks.adoptingAgentOnHost
  })
)

vi.mock('./cli-chat-resume-source', () => ({
  resolveCliChatResumeSource: mocks.resolveCliChatResumeSource
}))

vi.mock('./cli-chat-resume-close-terminal', () => ({
  cliChatResumeClosingPaneKeys: () => ['term-tab-1:leaf-1'],
  closeCliChatResumeTerminal: mocks.closeCliChatResumeTerminal
}))

vi.mock('./native-chat-cli-fork-run', () => ({
  reopenNativeChatCliForkOrigin: mocks.reopenNativeChatCliForkOrigin
}))

import { runCliChatResume } from './cli-chat-resume-run'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveCliChatResumeSource.mockReturnValue(SOURCE)
  mocks.adoptingAgentOnHost.mockResolvedValue('claude')
  mocks.supportsStructuredAgentSessionCliSource.mockResolvedValue(true)
  mocks.supportsStructuredAgentSessionCreateMessage.mockResolvedValue(true)
  mocks.structuredAgentSessionHostSupports.mockResolvedValue(true)
  mocks.probePtyRunningWork.mockResolvedValue([{ verdict: 'live', foregroundProcess: 'claude' }])
  mocks.admitStructuredLaunchOnHost.mockResolvedValue({ kind: 'admitted', writers: 'checked' })
  mocks.readStructuredChatHostPermissionVerdict.mockResolvedValue({ kind: 'allowed' })
  mocks.closeCliChatResumeTerminal.mockResolvedValue(true)
  mocks.reopenNativeChatCliForkOrigin.mockResolvedValue(false)
})

describe('runCliChatResume remote folder workspace safety', () => {
  it.each<{ label: string; settlement: StructuredAgentLaunchSettlement }>([
    {
      label: 'transcriptUnreadable refusal',
      settlement: {
        kind: 'failed',
        error: new StructuredAgentSessionCreateRefusalError(
          'agent_session_identity_required',
          'agent_session_identity_required',
          { code: 'agent_session_identity_required', details: { reason: 'transcriptUnreadable' } }
        )
      }
    },
    {
      label: 'journalUnavailable refusal',
      settlement: {
        kind: 'failed',
        error: new StructuredAgentSessionCreateRefusalError(
          'agent_session_journal_unreadable',
          'agent_session_journal_unreadable',
          { code: 'agent_session_journal_unreadable', details: { reason: 'journalUnavailable' } }
        )
      }
    },
    {
      label: 'unknown visibility outcome',
      settlement: {
        kind: 'visibility-unknown',
        sessionId: 'chat-1'
      }
    }
  ])(
    'keeps the originating terminal alive when create ends with $label',
    async ({ settlement }) => {
      mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
        expect(args.deferPublication).toBe(true)
        expect(args.plan.resumeFrom).toEqual({
          providerSessionId: SOURCE.providerSessionId,
          closingPaneKeys: ['term-tab-1:leaf-1']
        })
        return {
          sessionId: null,
          tab: null,
          settlement: Promise.resolve(settlement),
          cancel: vi.fn()
        }
      })

      await runCliChatResume(SOURCE)

      expect(mocks.closeCliChatResumeTerminal).not.toHaveBeenCalled()
    }
  )

  it('closes the originating terminal only after the remote chat create succeeds', async () => {
    const order: string[] = []
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation(() => {
      order.push('launch-begin')
      return {
        sessionId: null,
        tab: null,
        settlement: Promise.resolve().then(() => {
          order.push('launch-settled')
          return { kind: 'structured' as const, sessionId: 'chat-1' }
        }),
        cancel: vi.fn()
      }
    })
    mocks.closeCliChatResumeTerminal.mockImplementation(async () => {
      order.push('close-terminal')
      return true
    })

    await runCliChatResume(SOURCE)

    expect(order).toEqual(['launch-begin', 'launch-settled', 'close-terminal'])
    expect(mocks.closeCliChatResumeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps the terminal and omits closingPaneKeys when the remote host lacks create-closing-panes', async () => {
    mocks.structuredAgentSessionHostSupports.mockImplementation(async (_target, capability) => {
      if (capability === STRUCTURED_AGENT_SESSION_CREATE_CLOSING_PANES_RUNTIME_CAPABILITY) {
        return false
      }
      return capability === STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      expect(args.deferPublication).toBe(true)
      expect(args.plan.resumeFrom).toEqual({
        providerSessionId: SOURCE.providerSessionId,
        cliSource: {
          workspaceId: FOLDER_WORKSPACE_ID,
          paneKey: 'term-tab-1:leaf-1'
        }
      })
      return {
        sessionId: null,
        tab: null,
        settlement: Promise.resolve({ kind: 'structured' as const, sessionId: 'chat-1' }),
        cancel: vi.fn()
      }
    })

    await runCliChatResume(SOURCE)

    expect(mocks.closeCliChatResumeTerminal).not.toHaveBeenCalled()
  })
})
