// @vitest-environment happy-dom
import { mocks, host, call, launch, params } from './web-runtime-agent-launch-options.test-fixture'
import { createElement } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import type { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { expect, it, vi } from 'vitest'
import {
  WORKTREE_ID,
  ENVIRONMENT_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from '../testing/web-runtime-terminal-create.test-fixture'
import { stubRuntimeEnvironmentBridge } from '../../../rpc/testing/runtime-environment-bridge-fixture'

import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { LaunchAgentStartupPromptPlan } from '@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan'

import { createWebRuntimeSessionTerminalResult } from '../web-runtime-terminal-create-operation'
import * as settingsTransport from '../../../agent-launch-settings/agent-launch-settings-transport'
import * as sessionRequests from './agent-session-create-request'
import { replaceRuntimeEnvironmentRevisions } from '../../../rpc/environment-revisions/runtime-environment-revision'

it('refuses creation when the pairing changes during capability negotiation', async () => {
  const entered = Promise.withResolvers<void>()
  const negotiated = Promise.withResolvers<{ capable: boolean; complete: boolean }>()
  vi.spyOn(sessionRequests, 'agentSessionCreateCapabilities').mockImplementation(() => {
    entered.resolve()
    return negotiated.promise
  })
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1 }])
  try {
    const launched = launch({ sessionOptions: { effort: 'high' }, prompt: 'Keep this prompt' })
    await entered.promise
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 2 }])
    negotiated.resolve({ capable: true, complete: true })
    await expect(launched).resolves.toMatchObject({
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed' }
    })
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.createAgentSession'
    )
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.createTerminal'
    )
  } finally {
    replaceRuntimeEnvironmentRevisions([])
  }
})

it('refuses creation when the pairing changes during host snapshot retrieval', async () => {
  const entered = Promise.withResolvers<void>()
  const snapshot =
    Promise.withResolvers<
      Awaited<ReturnType<typeof settingsTransport.readHostAgentLaunchSettings>>
    >()
  host.capabilities = ['agent-session.host-authority.v1']
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockImplementation(() => {
    entered.resolve()
    return snapshot.promise
  })
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1 }])
  try {
    const launched = launch({ sessionOptions: { effort: 'high' }, prompt: 'Keep this prompt' })
    await entered.promise
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 2 }])
    snapshot.resolve(null)
    await expect(launched).resolves.toMatchObject({
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed' }
    })
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.createAgentSession'
    )
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.createTerminal'
    )
  } finally {
    replaceRuntimeEnvironmentRevisions([])
  }
})

it('refuses creation after capability negotiation is aborted', async () => {
  const entered = Promise.withResolvers<void>()
  const negotiated = Promise.withResolvers<{ capable: boolean; complete: boolean }>()
  vi.spyOn(sessionRequests, 'agentSessionCreateCapabilities').mockImplementation(() => {
    entered.resolve()
    return negotiated.promise
  })
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1 }])
  try {
    const launched = launch({ sessionOptions: { effort: 'high' }, prompt: 'Keep this prompt' })
    await entered.promise
    negotiated.reject(new DOMException('Pairing changed', 'AbortError'))
    await expect(launched).resolves.toMatchObject({
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed' }
    })
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.createAgentSession'
    )
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.createTerminal'
    )
  } finally {
    replaceRuntimeEnvironmentRevisions([])
  }
})

it('keeps paired + defaults host-owned and sends complete picks and action Arguments separately', async () => {
  const plainOutcome = await launch({
    buildStartup: () => {
      throw new Error('Invalid desktop command')
    }
  })
  expect(plainOutcome.outcome.status).toBe('created')
  const plain = params('terminal.createAgentSession')
  expect(plain).not.toHaveProperty('agentArgs')
  expect(plain).not.toHaveProperty('command')
  expect(plain).not.toHaveProperty('launchConfig')
  call.mockClear()
  await launch({
    sessionOptions: { model: 'sonnet', effort: 'high', fastMode: 'true' },
    actionAgentArgs: '--verbose',
    prompt: 'Inspect the change'
  })

  const picked = params('terminal.createAgentSession')
  expect(picked).toMatchObject({
    sessionOptions: { model: 'sonnet', effort: 'high', fastMode: 'true' },
    agentArgs: '--permission-mode auto --verbose',
    prompt: 'Inspect the change'
  })
  expect(picked).not.toHaveProperty('extraAgentArgs')
  expect(
    call.mock.calls.some(([request]) => request.method === 'session.tabs.createTerminal')
  ).toBe(false)
})

it('keeps host authority on older hosts and composes inexpressible picks only from the host snapshot', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  await launch({
    sessionOptions: { model: 'sonnet', effort: 'high', permissionMode: 'accept-edits' }
  })
  expect(params('terminal.createAgentSession')).toMatchObject({
    agentArgs: '--model sonnet --effort high --permission-mode acceptEdits --add-dir /host-tools'
  })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
  call.mockClear()
  await launch({ actionAgentArgs: '--verbose', sessionOptions: { permissionMode: 'full-access' } })
  expect(params('terminal.createAgentSession').agentArgs).toBe(
    '--dangerously-skip-permissions --verbose'
  )
  expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
  call.mockClear()
  host.capabilities.push('settings.agent-launch.choices.v1')
  await launch({ sessionOptions: { model: 'sonnet', permissionMode: 'accept-edits' } })
  expect(params('terminal.createAgentSession')).toMatchObject({
    launchPreferences: { model: 'sonnet', mode: 'accept-edits' }
  })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('agentArgs')
  call.mockClear()
  await launch({ sessionOptions: { effort: 'high' }, actionAgentArgs: '--verbose' })
  const picked = params('terminal.createAgentSession')
  expect(picked.agentArgs).toBe('--effort high --permission-mode auto --verbose')
  expect(picked).not.toHaveProperty('launchPreferences')
  expect(picked).not.toHaveProperty('command')
  expect(picked).not.toHaveProperty('env')
  expect(picked).not.toHaveProperty('sessionOptions')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    defaultTuiAgent: null,
    disabledTuiAgents: [],
    agentCmdOverrides: { claude: 'claude --model opus' },
    agentDefaultArgs: { claude: '--model sonnet --permission-mode auto --add-dir /host-tools' },
    environmentNames: {},
    permissionMode: 'mixed',
    agentChoices: {
      defaults: { claude: { model: 'sonnet' } },
      userArgs: { claude: '--add-dir /host-tools' }
    },
    agentPermission: {
      default: 'full-access',
      overrides: { claude: 'auto' },
      userArgs: { claude: '--add-dir /host-tools' }
    }
  })
  await launch({ actionAgentArgs: '--verbose', sessionOptions: { effort: 'high' } })
  const pinned = params('terminal.createAgentSession')
  expect(pinned.agentArgs).toBe('--effort high --permission-mode auto --verbose')
  expect(pinned).not.toHaveProperty('launchPreferences')
  call.mockClear()
  await launch({ sessionOptions: { effort: 'high' } })
  const nonAction = params('terminal.createAgentSession')
  expect(nonAction.agentArgs).toBe('--effort high --permission-mode auto --add-dir /host-tools')
  expect(nonAction).not.toHaveProperty('launchPreferences')
})

it('uses host defaults for structured v1.4.239 picks and retains explicitly authored Arguments', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: { claude: '--permission-mode auto --add-dir /host-tools' },
    environmentNames: {},
    permissionMode: 'mixed',
    agentPermission: {
      default: 'auto',
      overrides: {},
      userArgs: { claude: '--add-dir /host-tools' }
    }
  })
  await launch({ sessionOptions: { permissionMode: 'full-access', effort: 'high' } })

  expect(params('terminal.createAgentSession').agentArgs).toBe(
    '--effort high --dangerously-skip-permissions --add-dir /host-tools'
  )
  expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
  call.mockClear()
  await launch({
    agentArgs: '--dangerously-skip-permissions --add-dir /launch-tools',
    sessionOptions: { model: 'launch-only', permissionMode: 'full-access' }
  })

  const edited = params('terminal.createAgentSession')
  expect(edited.agentArgs).toBe(
    '--model launch-only --dangerously-skip-permissions --add-dir /launch-tools'
  )
  expect(edited).not.toHaveProperty('command')
  expect(edited).not.toHaveProperty('launchPreferences')
  call.mockClear()
  host.capabilities.push('agent-session.create-options.v1')
  await launch({ sessionOptions: { permissionMode: 'full-access', effort: 'high' } })

  expect(params('terminal.createAgentSession')).toMatchObject({
    sessionOptions: { permissionMode: 'full-access', effort: 'high' }
  })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('agentArgs')
})

it.each([
  {
    agentArgs: '--add-dir /tmp',
    expected: '--effort high --permission-mode default --add-dir /tmp'
  },
  { agentArgs: '', expected: '--effort high --permission-mode default' },
  { agentArgs: null, expected: '--effort high --permission-mode default' }
])(
  'compiles explicit picker Arguments $agentArgs with historical host defaults',
  async ({ agentArgs, expected }) => {
    host.capabilities = ['agent-session.host-authority.v1']
    await launch({ agentArgs, sessionOptions: { effort: 'high', permissionMode: 'ask' } })
    expect(params('terminal.createAgentSession').agentArgs).toBe(expected)
    expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
    expect(params('terminal.createAgentSession')).not.toHaveProperty('command')
  }
)

it.each([
  { fallback: 'legacy', capabilities: [], refusal: undefined },
  {
    fallback: 'agent_session_legacy_required',
    capabilities: ['agent-session.host-authority.v1', 'agent-session.create-options.v1'],
    refusal: 'agent_session_legacy_required'
  }
])(
  'prepares edited drafts from the historical host recipe through $fallback',
  async ({ capabilities, refusal }) => {
    host.capabilities = capabilities
    host.refusal = refusal
    vi.spyOn(settingsTransport, 'readHostAgentStartupSettings').mockImplementation(async () => {
      mocks.getState().runtimeStatusByEnvironmentId.set(ENVIRONMENT_ID, {
        status: { hostPlatform: 'linux', runtimeId: 'resolved-host' }
      })
      return {
        agentCmdOverrides: { claude: '/host/claude' },
        agentDefaultArgs: { claude: '' },
        agentDefaultEnv: { claude: { HOST_ENV: 'host' } },
        agentPermissionDefault: 'auto',
        agentLaunchChoices: {}
      }
    })
    await launch({
      agentArgs: '--add-dir /tmp',
      sessionOptions: { permissionMode: 'ask' },
      prompt: 'Keep this draft',
      promptDelivery: 'draft'
    })
    expect(params('session.tabs.createTerminal')).toMatchObject({
      command:
        "/host/claude '--add-dir' '/tmp' '--permission-mode' 'default' --prefill 'Keep this draft'",
      env: { HOST_ENV: 'host' }
    })
    expect(params('session.tabs.createTerminal')).not.toHaveProperty('agentPrompt')
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Keep this draft' })
    )
  }
)

it('requests a host-authoritative v1.4.239 continuation through the real Start handler', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  const entered = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<Awaited<ReturnType<typeof launch>>>()
  mocks.launched.mockImplementation((input) => {
    const completion = launch(input)
    entered.resolve()
    void completion.then(finished.resolve, finished.reject)
    return completion
  })
  const api = window.api
  vi.stubGlobal('window', document.defaultView)
  Object.assign(window, { api })
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    defaultTuiAgent: null,
    disabledTuiAgents: [],
    agentCmdOverrides: { claude: '/host/claude' },
    agentDefaultArgs: { claude: '--permission-mode default --add-dir /host-tools' },
    environmentNames: {},
    permissionMode: 'manual',
    agentPermission: {
      default: 'ask',
      overrides: {},
      userArgs: { claude: '--add-dir /host-tools' }
    }
  })
  Object.assign(mocks.getState(), { getKnownWorktreeById: () => null })
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    catalog: { origin: 'unknown' },
    terminal: { permissionMode: 'ask' },
    structured: {},
    arguments: '--add-dir /host-tools'
  }
  const draft: AgentPickerDraft = {
    agent: 'claude',
    surface: 'terminal',
    choices: { permissionMode: 'full-access' }
  }

  const row = { agent: 'claude', kind: 'cli', executionHostId: 'runtime:web-env-1' } as const
  mocks.observation.mockReturnValue({
    detection: { detectedIds: ['claude'] },
    model: { state: 'settled', rows: [row] },
    selectionFor: () => ({
      ready: true,
      cli: true,
      choice: { agent: 'claude', route: 'terminal-tui', executionHostId: row.executionHostId }
    })
  })
  mocks.picker.mockImplementation((props: Parameters<typeof AgentLaunchPicker>[0]) =>
    createElement('button', { onClick: () => props.onPick('claude', draft, entry) }, 'Full access')
  )
  const view = render(
    createElement(AgentSessionContinuationDialog, {
      open: true,
      onOpenChange: () => {},
      request: {
        worktreeId: WORKTREE_ID,
        workspacePath: '/worktree',
        launchSource: 'sidebar',
        source: { sourceAgent: 'claude', capturedText: 'Saved continuation context' }
      }
    })
  )
  fireEvent.click(view.getByText('Full access'))
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Start New Session' }))
    await entered.promise
    await finished.promise
  })
  const request = params('terminal.createAgentSession')
  expect(request.agentArgs).toBe('--dangerously-skip-permissions --add-dir /host-tools')
  expect(request).not.toHaveProperty('command')
  expect(request.prompt).toContain('Saved continuation context')
  expect(request.promptDelivery).toBe('draft')
  expect(
    call.mock.calls.some(([request]) => request.method === 'session.tabs.createTerminal')
  ).toBe(false)
})

it.each([
  {
    launchPlatform: 'win32' as const,
    hostShell: 'cmd.exe',
    hostArgs: '--add-dir "C:\\host tools"',
    snapshotArgs: '--permission-mode auto --add-dir "C:\\host tools"',
    expected:
      '--model "model with space" --effort high --permission-mode auto --add-dir "C:\\host tools"'
  },
  {
    launchPlatform: 'linux' as const,
    hostShell: 'wsl.exe',
    hostArgs: '--add-dir /host-tools',
    snapshotArgs: '--permission-mode auto --add-dir /host-tools',
    expected:
      "--model 'model with space' --effort high --permission-mode auto --add-dir /host-tools"
  }
])(
  'uses the host execution platform and shell for snapshot arguments ($hostShell)',
  async ({ launchPlatform, hostShell, hostArgs, snapshotArgs, expected }) => {
    host.capabilities = ['agent-session.host-authority.v1']
    mocks.getState().runtimeStatusByEnvironmentId = new Map([
      [ENVIRONMENT_ID, { status: { hostPlatform: 'win32', terminalWindowsShell: hostShell } }]
    ])
    vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
      defaultTuiAgent: null,
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: { claude: snapshotArgs },
      environmentNames: {},
      permissionMode: 'mixed',
      agentChoices: { defaults: {}, userArgs: { claude: hostArgs } },
      agentPermission: { default: 'auto', overrides: {}, userArgs: { claude: hostArgs } }
    })

    await launch({
      launchPlatform,
      sessionOptions: { model: 'model with space', effort: 'high', permissionMode: 'auto' }
    })
    expect(params('terminal.createAgentSession').agentArgs).toBe(expected)
  }
)

it('replaces recognized permission text from a historical host snapshot and retains ambiguous launches', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  const snapshot = {
    defaultTuiAgent: 'claude' as const,
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: { claude: '--dangerously-skip-permissions --add-dir /host-tools' },
    permissionMode: 'mixed' as const,
    environmentNames: {}
  }
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(snapshot)
  await launch({ sessionOptions: { permissionMode: 'ask' } })
  expect(params('terminal.createAgentSession').agentArgs).toBe(
    '--permission-mode default --add-dir /host-tools'
  )
  expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    ...snapshot,
    agentDefaultArgs: {
      claude: '--permission-mode auto --permission-mode default --add-dir /host-tools'
    }
  })
  await launch({
    sessionOptions: { permissionMode: 'ask' },
    buildStartup: () => ({
      startupPlan: {
        agent: 'claude',
        launchCommand: "desktop-claude '--permission-mode' 'default'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: 'desktop-claude',
          agentArgs: '--permission-mode default',
          agentEnv: {}
        }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    })
  })
  expect(params('session.tabs.createTerminal').command).toBe(
    "desktop-claude '--permission-mode' 'default'"
  )
})

it('keeps a cmd multiline draft out of the create request and pastes it after startup', async () => {
  await launch({
    launchPlatform: 'win32',
    launchShell: 'cmd',
    prompt: 'first line\nsecond line',
    promptDelivery: 'draft'
  })
  const request = params('terminal.createAgentSession')
  expect(request).not.toHaveProperty('prompt')
  expect(request).not.toHaveProperty('promptDelivery')
  expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({
      content: 'first line\nsecond line',
      agent: 'claude',
      submit: false
    })
  )
})

it('leaves terminal-unsupported permission out of the OpenCode wire request', async () => {
  const result = await launch({
    agent: 'opencode',
    sessionOptions: { permissionMode: 'ask' },
    prompt: 'Inspect the change'
  })
  expect(result.outcome.status).toBe('created')
  const request = params('terminal.createAgentSession')
  expect(request).toMatchObject({
    agent: 'opencode',
    prompt: 'Inspect the change',
    sessionOptions: {}
  })
  expect(request).not.toHaveProperty('launchPreferences')
  expect(request).not.toHaveProperty('agentArgs')
})

it('keeps a no-flag Ask pick structured without action Arguments on a create-options host', async () => {
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockRejectedValue(new Error('offline'))
  vi.spyOn(settingsTransport, 'readHostAgentStartupSettings').mockRejectedValue(
    new Error('offline')
  )
  await expect(
    launch({ agent: 'antigravity', sessionOptions: { permissionMode: 'ask' } })
  ).resolves.toMatchObject({ outcome: { status: 'created' } })
  const request = params('terminal.createAgentSession')
  expect(request.sessionOptions).toEqual({ permissionMode: 'ask' })
  expect(request).not.toHaveProperty('agentArgs')
  expect(request).not.toHaveProperty('command')
  expect(request).not.toHaveProperty('env')
})

it('retains explicit empty action Arguments with a structured no-flag Ask pick', async () => {
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockRejectedValue(new Error('offline'))
  vi.spyOn(settingsTransport, 'readHostAgentStartupSettings').mockRejectedValue(
    new Error('offline')
  )
  await expect(
    launch({ agent: 'antigravity', sessionOptions: { permissionMode: 'ask' }, actionAgentArgs: '' })
  ).resolves.toMatchObject({ outcome: { status: 'created' } })
  const request = params('terminal.createAgentSession')
  expect(request.sessionOptions).toEqual({ permissionMode: 'ask' })
  expect(request).toHaveProperty('agentArgs', '')
  expect(request).not.toHaveProperty('command')
  expect(request).not.toHaveProperty('env')
})

it.each([
  { negotiation: 'host authority only', capabilities: ['agent-session.host-authority.v1'] },
  {
    negotiation: 'host authority with choices',
    capabilities: ['agent-session.host-authority.v1', 'settings.agent-launch.choices.v1']
  }
])('compiles a no-flag Ask pick to empty Arguments on $negotiation', async ({ capabilities }) => {
  host.capabilities = capabilities
  await launch({ agent: 'antigravity', sessionOptions: { permissionMode: 'ask' } })
  const request = params('terminal.createAgentSession')
  expect(request).toHaveProperty('agentArgs', '')
  expect(request).not.toHaveProperty('launchPreferences')
  expect(request).not.toHaveProperty('sessionOptions')
  expect(request).not.toHaveProperty('command')
  expect(request).not.toHaveProperty('env')
})

it('preserves empty action text and inherits permission from text-only host snapshots', async () => {
  await launch({ actionAgentArgs: '' })
  expect(params('terminal.createAgentSession').agentArgs).toBe('--permission-mode auto')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: { claude: '--permission-mode auto --add-dir /host-tools' },
    permissionMode: 'mixed',
    environmentNames: {}
  })
  await launch({ actionAgentArgs: '--verbose' })
  expect(params('terminal.createAgentSession').agentArgs).toBe('--permission-mode auto --verbose')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(null)
  await launch({
    actionAgentArgs: '--verbose',
    prompt: 'Keep this draft',
    promptDelivery: 'draft',
    buildStartup: () => ({
      startupPlan: {
        agent: 'claude',
        launchCommand: "desktop-claude '--verbose' --prefill 'Keep this draft'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentCommand: 'desktop-claude', agentArgs: '--verbose', agentEnv: {} }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    })
  })
  expect(params('session.tabs.createTerminal').command).toBe(
    "desktop-claude '--verbose' --prefill 'Keep this draft'"
  )
  expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Keep this draft' })
  )
})

it.each<{
  pick: string
  sessionOptions: Record<string, string>
  startup: LaunchAgentStartupPromptPlan
  expectedCommand: string
}>([
  {
    pick: 'effort',
    sessionOptions: { effort: 'high' },
    startup: {
      startupPlan: {
        agent: 'claude',
        launchCommand: "desktop-claude '--effort' 'high'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentCommand: 'desktop-claude', agentArgs: '--effort high', agentEnv: {} }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    },
    expectedCommand: "desktop-claude '--effort' 'high'"
  },
  {
    pick: 'permission',
    sessionOptions: { permissionMode: 'full-access' },
    startup: {
      startupPlan: {
        agent: 'claude',
        launchCommand: 'desktop-claude --dangerously-skip-permissions',
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: 'desktop-claude',
          agentArgs: '--dangerously-skip-permissions',
          agentEnv: {}
        }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    },
    expectedCommand: 'desktop-claude --dangerously-skip-permissions'
  }
])(
  'uses the caller prepared $pick launch when an older host snapshot is unavailable',
  async ({ sessionOptions, startup, expectedCommand }) => {
    host.capabilities = ['agent-session.host-authority.v1']
    vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(null)
    await launch({ sessionOptions, buildStartup: () => startup })
    expect(params('session.tabs.createTerminal').command).toBe(expectedCommand)
  }
)

it('keeps the prepared permission environment for an older host', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  await launch({
    agent: 'goose',
    sessionOptions: { permissionMode: 'full-access' },
    buildStartup: () => ({
      startupPlan: {
        agent: 'goose',
        launchCommand: 'goose',
        expectedProcess: 'goose',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: { GOOSE_MODE: 'auto' } },
        env: { GOOSE_MODE: 'auto' }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    })
  })
  expect(params('session.tabs.createTerminal')).toMatchObject({
    env: { GOOSE_MODE: 'auto' }
  })
  expect(
    call.mock.calls.some(([request]) => request.method === 'terminal.createAgentSession')
  ).toBe(false)
})

it.each([
  { fallback: 'legacy', capabilities: [], refusal: undefined },
  {
    fallback: 'agent_session_legacy_required',
    capabilities: ['agent-session.host-authority.v1', 'agent-session.create-options.v1'],
    refusal: 'agent_session_legacy_required'
  },
  {
    fallback: 'method_not_found',
    capabilities: ['agent-session.host-authority.v1', 'agent-session.create-options.v1'],
    refusal: 'method_not_found'
  }
])(
  'lets the host plan plain prompted launches through $fallback fallback',
  async ({ capabilities, refusal }) => {
    host.capabilities = capabilities
    host.refusal = refusal
    await launch({ prompt: 'Inspect this change' })
    const legacy = params('session.tabs.createTerminal')
    expect(legacy).toMatchObject({
      agent: 'claude',
      launchAgent: 'claude',
      agentPrompt: 'Inspect this change'
    })
    expect(legacy).not.toHaveProperty('command')
    expect(legacy).not.toHaveProperty('launchConfig')
    call.mockClear()
    await launch({ agent: 'goose', prompt: 'Keep this editable' })
    expect(params('session.tabs.createTerminal')).not.toHaveProperty('agentPrompt')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Keep this editable', submit: false })
    )
  }
)

it('retains legacy drafts and submit-after-ready suppression and delivery', async () => {
  host.capabilities = []
  await launch({
    prompt: 'Edit this draft',
    promptDelivery: 'draft',
    buildStartup: () => ({
      startupPlan: {
        agent: 'claude',
        launchCommand: "desktop-claude --prefill 'Edit this draft'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentCommand: 'desktop-claude', agentArgs: '', agentEnv: {} }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    })
  })
  expect(params('session.tabs.createTerminal').command).toBe(
    "desktop-claude --prefill 'Edit this draft'"
  )
  expect(params('session.tabs.createTerminal')).not.toHaveProperty('agentPrompt')
  expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Edit this draft' })
  )
  call.mockClear()
  host.capabilities = ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
  resetTerminalCreateEnvironment()
  stubTerminalCreateEnvironment(mocks)
  stubRuntimeEnvironmentBridge({ call })
  await launch({ prompt: 'Submit this after startup', promptDelivery: 'submit-after-ready' })
  expect(params('terminal.createAgentSession')).toMatchObject({ promptDelivery: 'auto-submit' })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('prompt')
  expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'Submit this after startup', submit: true })
  )
})

it('preserves explicit empty overrides and prepared workspace drafts while resume retains its recipe', async () => {
  await launch({ agentArgs: '' })
  expect(params('terminal.createAgentSession')).toHaveProperty('agentArgs', '')
  call.mockClear()
  const recipe = { agentArgs: '--recorded-arguments', agentEnv: {} }
  await createWebRuntimeSessionTerminalResult({
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    agentSessionKind: 'fresh',
    launchAgent: 'claude',
    preparedAgentCommand: true,
    command: "claude --prefill 'workspace draft'",
    launchConfig: recipe,
    activate: false
  })
  expect(params('session.tabs.createTerminal')).toMatchObject({
    command: "claude --prefill 'workspace draft'",
    launchConfig: { agentArgs: '--recorded-arguments', agentEnv: {} }
  })
  call.mockClear()
  await createWebRuntimeSessionTerminalResult({
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    agentSessionKind: 'resume',
    launchAgent: 'claude',
    launchConfig: recipe,
    providerSession: { key: 'session_id', id: 'recorded-session' },
    activate: false
  })
  expect(params('terminal.ensureAgentSession')).toHaveProperty('agentArgs', '--recorded-arguments')
})

it('keeps the folder selected after background creation and prompt delivery settle', async () => {
  const state = {
    ...mocks.getState(),
    activeWorktreeId: 'folder:feature',
    activeWorkspaceKey: 'folder:feature',
    activeWorkspaceExecutionHostId: 'local'
  }
  mocks.getState.mockImplementation(() => state)
  mocks.setActiveWorktree.mockImplementation((id: string, hostId: string) => {
    state.activeWorktreeId = id
    state.activeWorkspaceKey = id
    state.activeWorkspaceExecutionHostId = hostId
  })
  const result = await launch({
    agent: 'claude',
    activate: false,
    prompt: 'Resolve the conflicts',
    promptDelivery: 'submit-after-ready'
  })
  expect(result).toMatchObject({ delivered: true, outcome: { status: 'created' } })
  expect(state.activeWorkspaceKey).toBe('folder:feature')
  expect(state.activeWorktreeId).toBe('folder:feature')
  expect(state.activeWorkspaceExecutionHostId).toBe('local')
})
