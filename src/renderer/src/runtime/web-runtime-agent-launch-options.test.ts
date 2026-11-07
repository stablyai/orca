// @vitest-environment happy-dom
import { mocks, host, call, launch, params } from './web-runtime-agent-launch-options.test-fixture'
import { createElement } from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import type { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { expect, it, vi } from 'vitest'
import {
  WORKTREE_ID,
  ENVIRONMENT_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

import {
  agentPickerDraft,
  agentPickerFreshLaunchInputs,
  type AgentPickerEntry
} from '../../../shared/agent-launch/picker/agent-launch-picker'
import { agentPickerChoiceSeeds } from '../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import {
  applyAgentPickerEdit,
  acceptAgentPickerArguments
} from '../../../shared/agent-launch/picker/agent-launch-picker-edits'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch/choices/agent-launch-settings'
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import * as settingsTransport from './agent-launch-settings/agent-launch-settings-transport'
import * as sessionRequests from './agent-session-create-request'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

it.each(['capabilities', 'snapshot', 'cancelled probe'])(
  'cancels a launch whose pairing changes during %s without dispatching creation',
  async (phase) => {
    const negotiated = Promise.withResolvers<{ capable: boolean; complete: boolean }>()
    const snapshot =
      Promise.withResolvers<
        Awaited<ReturnType<typeof settingsTransport.readHostAgentLaunchSettings>>
      >()
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1 }])
    if (phase === 'snapshot') {
      host.capabilities = ['agent-session.host-authority.v1']
      vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockReturnValue(snapshot.promise)
    } else {
      vi.spyOn(sessionRequests, 'agentSessionCreateCapabilities').mockReturnValue(
        negotiated.promise
      )
    }
    try {
      const launched = launch({ sessionOptions: { effort: 'high' }, prompt: 'Keep this prompt' })
      if (phase === 'snapshot') {
        await vi.waitFor(() =>
          expect(settingsTransport.readHostAgentLaunchSettings).toHaveBeenCalledOnce()
        )
      }
      if (phase === 'cancelled probe') {
        negotiated.reject(new DOMException('Pairing changed', 'AbortError'))
      } else {
        replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 2 }])
        negotiated.resolve({ capable: true, complete: true })
        snapshot.resolve(null)
      }
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
      expect(mocks.toastError).not.toHaveBeenCalled()
    } finally {
      replaceRuntimeEnvironmentRevisions([])
    }
  }
)

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
  const projection = projectSourceControlActionLaunch(
    {
      agentId: 'claude',
      agentArgs: '--verbose',
      launchPreferences: {
        agentId: 'claude',
        model: 'sonnet',
        options: { effort: 'high', fastMode: 'true' }
      }
    },
    'claude',
    { basePrompt: 'Inspect the change', settings: { agentPermissionDefault: 'ask' } }
  )
  await launch({
    sessionOptions: projection.sessionOptions,
    actionAgentArgs: projection.actionAgentArgs,
    prompt: projection.commandInput
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
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(
    projectAgentLaunchSettings(
      {
        agentPermissionDefault: 'full-access',
        agentPermissionOverrides: { claude: 'auto' },
        agentCmdOverrides: { claude: 'claude --model opus' },
        agentLaunchChoices: { claude: { model: 'sonnet' } },
        agentDefaultArgs: { claude: '--add-dir /host-tools' }
      },
      'linux'
    )
  )
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

it('keeps picker-seeded desktop Arguments off a v1.4.239 host and retains explicit Arguments edits', async () => {
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
  const row = { agent: 'claude', kind: 'cli', executionHostId: 'runtime:paired' } as const
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [row],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    catalog: { origin: 'unknown' },
    ...agentPickerChoiceSeeds('claude', {
      agentPermissionDefault: 'ask',
      agentDefaultArgs: { claude: '--model desktop-only-qa' }
    })
  }
  let draft = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
    kind: 'permission',
    value: 'full-access'
  })
  draft = applyAgentPickerEdit(entry, draft, {
    kind: 'choice',
    patch: { options: { effort: 'high' } }
  })
  await launch(
    agentPickerFreshLaunchInputs(
      draft,
      { surface: 'terminal', executionHostId: row.executionHostId },
      entry
    )
  )
  expect(params('terminal.createAgentSession').agentArgs).toBe(
    '--effort high --dangerously-skip-permissions --add-dir /host-tools'
  )
  expect(params('terminal.createAgentSession')).not.toHaveProperty('launchPreferences')
  expect(mocks.toastError).not.toHaveBeenCalled()
  call.mockClear()
  const authored = acceptAgentPickerArguments(
    entry,
    applyAgentPickerEdit(entry, draft, {
      kind: 'arguments',
      text: '--model launch-only --add-dir /launch-tools'
    })
  )
  await launch(
    agentPickerFreshLaunchInputs(
      authored,
      { surface: 'terminal', executionHostId: row.executionHostId },
      entry
    )
  )
  const edited = params('terminal.createAgentSession')
  expect(edited.agentArgs).toBe(
    '--model launch-only --dangerously-skip-permissions --add-dir /launch-tools'
  )
  expect(edited).not.toHaveProperty('command')
  expect(edited).not.toHaveProperty('launchPreferences')
  call.mockClear()
  host.capabilities.push('agent-session.create-options.v1')
  await launch(
    agentPickerFreshLaunchInputs(
      draft,
      { surface: 'terminal', executionHostId: row.executionHostId },
      entry
    )
  )
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

it.each(['legacy', 'agent_session_legacy_required'])(
  'prepares edited drafts from the historical host recipe through %s',
  async (fallback) => {
    host.capabilities =
      fallback === 'legacy'
        ? []
        : ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
    host.refusal = fallback === 'legacy' ? undefined : fallback
    const read = vi
      .spyOn(settingsTransport, 'readHostAgentStartupSettings')
      .mockImplementation(async () => {
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
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ environmentId: ENVIRONMENT_ID }))
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Keep this draft' })
    )
  }
)

it('requests a host-authoritative v1.4.239 continuation through the real Start handler', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  mocks.launched.mockImplementation(launch)
  const api = window.api
  vi.stubGlobal('window', document.defaultView)
  Object.assign(window, { api })
  const hostSettings = {
    agentPermissionDefault: 'ask' as const,
    agentCmdOverrides: { claude: '/host/claude' },
    agentDefaultArgs: { claude: '--add-dir /host-tools' }
  }
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(
    projectAgentLaunchSettings(hostSettings)
  )
  Object.assign(mocks.getState(), { getKnownWorktreeById: () => null })
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    catalog: { origin: 'unknown' },
    ...agentPickerChoiceSeeds('claude', hostSettings)
  }
  const draft = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
    kind: 'permission',
    value: 'full-access'
  })
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
  fireEvent.click(view.getByRole('button', { name: 'Start New Session' }))
  await waitFor(() => expect(mocks.launched).toHaveBeenCalled())
  await act(async () => {
    await mocks.launched.mock.results[0].value
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
    expected:
      '--model "model with space" --effort high --permission-mode auto --add-dir "C:\\host tools"'
  },
  {
    launchPlatform: 'linux' as const,
    hostShell: 'wsl.exe',
    expected:
      "--model 'model with space' --effort high --permission-mode auto --add-dir /host-tools"
  }
])(
  'uses the host execution platform and shell for snapshot arguments ($hostShell)',
  async ({ launchPlatform, hostShell, expected }) => {
    host.capabilities = ['agent-session.host-authority.v1']
    mocks.getState().runtimeStatusByEnvironmentId = new Map([
      [ENVIRONMENT_ID, { status: { hostPlatform: 'win32', terminalWindowsShell: hostShell } }]
    ])
    vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(
      projectAgentLaunchSettings(
        {
          agentPermissionDefault: 'auto',
          agentLaunchChoices: {},
          agentDefaultArgs: {
            claude:
              launchPlatform === 'win32' ? '--add-dir "C:\\host tools"' : '--add-dir /host-tools'
          }
        },
        launchPlatform
      )
    )
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
  await launch({ sessionOptions: { permissionMode: 'ask' } })
  expect(params('session.tabs.createTerminal').command).toContain('desktop-claude')
  expect(params('session.tabs.createTerminal').command).toContain("'--permission-mode' 'default'")
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

it('leaves chat-only permission out of an OpenCode terminal action request', async () => {
  const projection = projectSourceControlActionLaunch(
    {
      agentId: 'opencode',
      surface: 'terminal',
      launchPreferences: { agentId: 'opencode', permissionMode: 'ask' }
    },
    'opencode',
    { basePrompt: 'Inspect the change' }
  )
  const result = await launch({
    agent: 'opencode',
    sessionOptions: projection.sessionOptions,
    prompt: projection.commandInput
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

it.each([undefined, ''])(
  'keeps a no-flag Ask pick structured with action Arguments %j on a create-options host',
  async (agentArgs) => {
    vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockRejectedValue(new Error('offline'))
    vi.spyOn(settingsTransport, 'readHostAgentStartupSettings').mockRejectedValue(
      new Error('offline')
    )
    const projection = projectSourceControlActionLaunch(
      {
        agentId: 'antigravity',
        surface: 'terminal',
        ...(agentArgs !== undefined ? { agentArgs } : {}),
        launchPreferences: { agentId: 'antigravity', permissionMode: 'ask' }
      },
      'antigravity',
      { basePrompt: '' }
    )
    await expect(
      launch({
        agent: 'antigravity',
        buildStartup: () => {
          throw new Error('Unexpected prepared launch')
        },
        sessionOptions: projection.sessionOptions,
        actionAgentArgs: projection.actionAgentArgs
      })
    ).resolves.toMatchObject({ outcome: { status: 'created' } })
    const request = params('terminal.createAgentSession')
    expect(request.sessionOptions).toEqual({ permissionMode: 'ask' })
    expect(request).not.toHaveProperty('command')
    expect(request).not.toHaveProperty('env')
    if (agentArgs === undefined) {
      expect(request).not.toHaveProperty('agentArgs')
    } else {
      expect(request).toHaveProperty('agentArgs', '')
    }
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'antigravity',
      settings: {
        agentPermissionDefault: 'full-access',
        agentCmdOverrides: { antigravity: '/host/agy' },
        agentDefaultEnv: { antigravity: { HOST_ENV: 'host' } }
      },
      platform: 'linux',
      isRemote: false,
      shell: 'posix',
      ...(typeof request.agentArgs === 'string' ? { agentArgs: request.agentArgs } : {}),
      // Asserted above to be exactly this request's sessionOptions.
      sessionOptions: { permissionMode: 'ask' }
    })
    expect(
      buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
    ).toMatchObject({
      launchCommand: '/host/agy',
      env: { HOST_ENV: 'host' }
    })
  }
)

it.each([false, true])(
  'compiles a no-flag Ask action pick to empty Arguments on an older host (choices=%s)',
  async (choices) => {
    host.capabilities = [
      'agent-session.host-authority.v1',
      ...(choices ? ['settings.agent-launch.choices.v1'] : [])
    ]
    const projection = projectSourceControlActionLaunch(
      {
        agentId: 'antigravity',
        surface: 'terminal',
        launchPreferences: { agentId: 'antigravity', permissionMode: 'ask' }
      },
      'antigravity',
      { basePrompt: '' }
    )
    await launch({ agent: 'antigravity', sessionOptions: projection.sessionOptions })
    const request = params('terminal.createAgentSession')
    expect(request).toHaveProperty('agentArgs', '')
    expect(request).not.toHaveProperty('launchPreferences')
    expect(request).not.toHaveProperty('sessionOptions')
    expect(request).not.toHaveProperty('command')
    expect(request).not.toHaveProperty('env')
  }
)

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
  await launch({ actionAgentArgs: '--verbose', prompt: 'Keep this draft', promptDelivery: 'draft' })
  expect(params('session.tabs.createTerminal').command).toContain('--prefill')
  expect(params('session.tabs.createTerminal').command).toContain('--verbose')
  expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Keep this draft' })
  )
})

it.each<Record<string, string>>([{ effort: 'high' }, { permissionMode: 'full-access' }])(
  'keeps the prepared launch when an older host snapshot is unavailable (%j)',
  async (sessionOptions) => {
    host.capabilities = ['agent-session.host-authority.v1']
    vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(null)
    await launch({ sessionOptions })
    expect(params('session.tabs.createTerminal').command).toContain('desktop-claude')
    expect(params('session.tabs.createTerminal').command).toContain(
      sessionOptions.effort ? "'high'" : '--dangerously-skip-permissions'
    )
  }
)

it('keeps the prepared permission environment for an older host', async () => {
  host.capabilities = ['agent-session.host-authority.v1']
  await launch({ agent: 'goose', sessionOptions: { permissionMode: 'full-access' } })
  expect(params('session.tabs.createTerminal')).toMatchObject({
    env: { GOOSE_MODE: 'auto' }
  })
  expect(
    call.mock.calls.some(([request]) => request.method === 'terminal.createAgentSession')
  ).toBe(false)
})

it.each(['legacy', 'agent_session_legacy_required', 'method_not_found'])(
  'lets the host plan plain prompted launches through %s fallback',
  async (fallback) => {
    if (fallback === 'legacy') {
      host.capabilities = []
    } else {
      host.refusal = fallback
    }
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
  await launch({ prompt: 'Edit this draft', promptDelivery: 'draft' })
  expect(params('session.tabs.createTerminal').command).toContain('--prefill')
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
    launchConfig: recipe
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

// Background section launches carry a prompt too; selection must survive async host creation.
it.each(['claude', 'codex'] as const)(
  'keeps the folder selected after background %s creation and prompt delivery settle',
  async (agent) => {
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
      agent,
      activate: false,
      prompt: 'Resolve the conflicts',
      promptDelivery: 'submit-after-ready'
    })
    expect(result).toMatchObject({ delivered: true, outcome: { status: 'created' } })
    expect(state.activeWorkspaceKey).toBe('folder:feature')
    expect(state.activeWorktreeId).toBe('folder:feature')
    expect(state.activeWorkspaceExecutionHostId).toBe('local')
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  }
)
