// @vitest-environment happy-dom

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type * as LocalRuntimeCapabilitiesModule from '@/runtime/local-runtime-capabilities'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  terminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTabWithOutcome: mocks.terminal }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => ({ supported: false, reason: 'wsl' }))
}))
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalRuntimeCapabilitiesModule>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
  ]
}))

import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

afterEach(() => {
  mocks.activateAndRevealFolderWorkspace.mockReset()
  mocks.terminal.mockReset()
})

function create(
  surface?: 'terminal',
  createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
): Promise<boolean> {
  return submitFolderWorkspaceCreate({
    projectGroup: makeProjectGroup(),
    name: '',
    lastAutoName: '',
    linkedWorkItem: null,
    note: 'Fix the flaky checkout flow',
    quickAgent: 'claude',
    launchChoice: {
      agent: 'claude',
      route: surface ? 'terminal-tui' : 'structured-native-chat',
      executionHostId: 'local',
      requestedSurface: surface ?? 'chat'
    },
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    createFolderWorkspace,
    onOpenChange: vi.fn()
  })
}

describe('submitFolderWorkspaceCreate surface pick', () => {
  it('starts the CLI in a terminal for a terminal pick even when chats are the default', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), nativeChatProviders: EVERY_AGENT_CHAT }
    })
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })

    mocks.terminal.mockReturnValue({ surface: { kind: 'host-published' } })
    const materialization = Promise.withResolvers<ReturnType<typeof makeFolderWorkspace>>()
    const creating = create(
      undefined,
      vi.fn(() => materialization.promise)
    )
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), nativeChatProviders: {} }
    })
    materialization.resolve(makeFolderWorkspace())
    await creating
    await vi.waitFor(() => expect(mocks.terminal).toHaveBeenCalledOnce())
    expect(mocks.terminal.mock.calls[0]?.[0]).toMatchObject({
      agent: 'claude',
      prompt: 'Fix the flaky checkout flow',
      agentSessionLaunchPlan: { route: 'terminal-tui' }
    })

    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), nativeChatProviders: EVERY_AGENT_CHAT }
    })
    await create('terminal')
    expect(mocks.terminal).toHaveBeenCalledOnce()
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls.at(-1)?.[1]?.startup
    expect(startup?.command).toContain('claude')
    expect(startup?.command).toContain('Fix the flaky checkout flow')
  })
})
