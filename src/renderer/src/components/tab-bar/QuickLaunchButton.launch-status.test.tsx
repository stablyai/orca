// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render as renderElement,
  renderHook,
  screen
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchState } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type { StructuredLaunchAttempt } from '@/lib/structured-agent-session-launch-request'
import type * as WorktreeFixtures from '@/store/slices/worktrees-slice-test-fixtures'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex'] })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store', async () => {
  const { makeWorktree, TEST_REPO } = await vi.importActual<typeof WorktreeFixtures>(
    '@/store/slices/worktrees-slice-test-fixtures'
  )
  const state = {
    settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'worktree-1', repoId: TEST_REPO.id, hostId: 'local' })]
    },
    repos: [TEST_REPO],
    activeWorktreeId: 'worktree-1',
    tabsByWorktree: { 'worktree-1': [{ id: 'starting-tab', ptyId: null }] },
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  }
  const useAppStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
  return { useAppStore }
})
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ],
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))
const launchMock = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastMessage = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: toastError, message: toastMessage, success: vi.fn() }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launchMock }))
vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({ useWorktreeAgentRows: () => [] }))
vi.mock('@/runtime/structured-chat-name-observation', () => ({
  useStructuredChatTabNames: () => new Map(),
  getStructuredChatTabNames: () => new Map()
}))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 0 }))

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ReviewNotesSendMenuContent } from '@/components/editor/ReviewNotesSendMenuContent'
import {
  QuickLaunchAgentMenuItems,
  ProjectedAgentMenuItems,
  useTabAgentMenuLaunch
} from './QuickLaunchButton'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import * as menuRows from './use-new-tab-agent-menu-rows'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'

const WORKTREE_ID = 'worktree-1'

function render(children: ReactNode, defaultOpen = true): ReturnType<typeof renderElement> {
  return renderElement(
    <DropdownMenu defaultOpen={defaultOpen} modal={false}>
      <DropdownMenuTrigger>Agents</DropdownMenuTrigger>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

function reopenMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents' }), {
    button: 0,
    ctrlKey: false
  })
}

function choiceModel(kind: 'cli' | 'chat'): menuRows.NewTabAgentMenuModel {
  return {
    state: 'settled',
    rows: [
      kind === 'cli'
        ? { kind, agent: 'codex', chat: true, executionHostId: 'runtime:server' }
        : { kind, agent: 'codex', executionHostId: 'runtime:server' }
    ],
    detection: {
      detectedIds: ['codex'],
      detectionFailed: false,
      needsServerUpdate: false,
      isLoading: false,
      isRefreshing: false,
      refresh: async () => ['codex']
    }
  }
}

function renderChoice(
  kind: 'cli' | 'chat',
  disabled = false,
  defaultOpen = true
): { row: HTMLElement; button: HTMLElement } {
  vi.spyOn(menuRows, 'useNewTabAgentMenuRows').mockReturnValue(choiceModel(kind))
  launchMock.mockReset().mockReturnValue({ surface: { kind: 'host-published' } })
  render(
    <QuickLaunchAgentMenuItems
      worktreeId={WORKTREE_ID}
      groupId="group-1"
      onFocusTerminal={vi.fn()}
      disabled={disabled}
    />,
    defaultOpen
  )
  if (!defaultOpen) {
    reopenMenu()
  }
  return {
    row: screen.getByRole('menuitem', {
      name: kind === 'cli' ? 'Launch Codex in a new terminal' : 'Start a chat with Codex'
    }),
    button: screen.getByRole('button', {
      name: kind === 'cli' ? 'Start a chat with Codex' : 'Launch Codex in a new terminal'
    })
  }
}

function hover(button: HTMLElement): void {
  const matches = button.matches.bind(button)
  vi.spyOn(button, 'matches').mockImplementation(
    (selector) => selector === ':hover' || matches(selector)
  )
}

function expectLaunch(surface: 'chat' | 'terminal'): void {
  expect(launchMock).toHaveBeenCalledOnce()
  expect(launchMock.mock.calls[0][0]).toMatchObject({
    requestedSurface: surface,
    selectedExecutionHostId: 'runtime:server'
  })
  expect(screen.queryByRole('menu')).toBeNull()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each(['cli', 'chat'] as const)(
  'activates the focused %s control despite parked alternate hover (R1)',
  async (kind) => {
    for (const action of [
      'return-left',
      'return-up',
      'space',
      'row-click',
      'button-click',
      'button-enter',
      'button-space',
      'pointer'
    ] as const) {
      const { row, button } = renderChoice(kind)
      if (action !== 'button-click') {
        hover(button)
      }
      act(() => row.focus())
      if (action === 'return-left' || action === 'return-up' || action.startsWith('button-')) {
        fireEvent.keyDown(row, { key: 'ArrowRight' })
        expect(document.activeElement).toBe(button)
      }
      if (action === 'return-left') {
        fireEvent.keyDown(button, { key: 'ArrowLeft' })
      }
      if (action === 'return-up') {
        fireEvent.keyDown(button, { key: 'ArrowDown' })
        await vi.waitFor(() =>
          expect(document.activeElement?.textContent).toContain('Agent settings')
        )
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
        await vi.waitFor(() => expect(document.activeElement).toBe(row))
      }
      if (action === 'row-click') {
        act(() => {
          button.focus()
          row.click()
        })
      } else if (action === 'button-click') {
        act(() => {
          row.focus()
          button.click()
        })
      } else if (action === 'pointer') {
        fireEvent.pointerDown(button, { pointerType: 'mouse' })
        fireEvent.pointerUp(button, { pointerType: 'mouse' })
        fireEvent.click(button)
      } else {
        const alternate = action.startsWith('button-')
        if (!alternate) {
          expect(document.activeElement).toBe(row)
        }
        fireEvent.keyDown(alternate ? button : row, {
          key: action.endsWith('space') ? ' ' : 'Enter'
        })
      }
      expectLaunch(
        action.startsWith('button-') || action === 'pointer'
          ? kind === 'cli'
            ? 'chat'
            : 'terminal'
          : kind === 'cli'
            ? 'terminal'
            : 'chat'
      )
      cleanup()
    }
  }
)

it.each(['cli', 'chat'] as const)(
  'keeps %s drag release exact-once, expires unused release, and respects disabled',
  async (kind) => {
    for (const alternate of [true, false]) {
      const { row, button } = renderChoice(kind, false, false)
      hover(button)
      fireEvent.pointerUp(alternate ? button : row, { pointerType: 'mouse' })
      expectLaunch(
        alternate ? (kind === 'cli' ? 'chat' : 'terminal') : kind === 'cli' ? 'terminal' : 'chat'
      )
      cleanup()
    }
    for (const deferred of [false, true]) {
      const { row, button } = renderChoice(kind)
      hover(button)
      act(() => {
        fireEvent.pointerDown(row, { pointerType: 'mouse' })
        fireEvent.pointerUp(button, { pointerType: 'mouse' })
        expect(launchMock).not.toHaveBeenCalled()
        if (!deferred) {
          row.click()
        }
      })
      if (deferred) {
        await act(async () => {
          await Promise.resolve()
          row.click()
        })
      }
      expectLaunch(kind === 'cli' ? 'terminal' : 'chat')
      cleanup()
    }
    const { row, button } = renderChoice(kind, true)
    hover(button)
    fireEvent.pointerUp(button, { pointerType: 'mouse' })
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    act(() => row.click())
    expect(launchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeNull()
  }
)

it.each(['chat', 'cli'] as const)(
  'preserves notes inputs and failure outcomes on the %s row chat action',
  async (kind) => {
    vi.spyOn(menuRows, 'useNewTabAgentMenuRows').mockReturnValue(choiceModel(kind))
    for (const outcome of ['delivered', 'unconfirmed', 'notified', 'no-command'] as const) {
      const onPromptDelivered = vi.fn()
      const onPromptHandedOff = vi.fn()
      launchMock.mockReset().mockReturnValue(
        outcome === 'no-command'
          ? null
          : {
              surface: { kind: 'host-published' },
              promptDeliveryResult: Promise.resolve({
                delivered: outcome === 'delivered',
                failureNotified: outcome === 'notified',
                unconfirmed: outcome === 'unconfirmed'
              })
            }
      )
      toastError.mockClear()
      const prompt = 'Review notes\nsrc/example.ts:5 — keep this context'
      render(
        <ReviewNotesSendMenuContent
          worktreeId={WORKTREE_ID}
          groupId="group-1"
          prompt={prompt}
          onPromptDelivered={onPromptDelivered}
          onPromptHandedOff={onPromptHandedOff}
        />
      )
      fireEvent.click(
        screen.getByRole(kind === 'chat' ? 'menuitem' : 'button', {
          name: 'Start a chat with Codex'
        })
      )
      expectLaunch('chat')
      expect(launchMock.mock.calls[0][0]).toMatchObject({
        prompt,
        promptDelivery: 'submit-after-ready',
        launchSource: 'notes_send',
        promptKeptByCaller: true,
        groupId: 'group-1',
        onPromptDelivered
      })
      if (outcome === 'no-command') {
        expect(onPromptHandedOff).not.toHaveBeenCalled()
      } else {
        expect(onPromptHandedOff).toHaveBeenCalledOnce()
        await expect(onPromptHandedOff.mock.calls[0][0]).resolves.toMatchObject({
          delivered: outcome === 'delivered'
        })
      }
      expect(toastError).toHaveBeenCalledTimes(
        outcome === 'unconfirmed' || outcome === 'no-command' ? 1 : 0
      )
      if (outcome === 'unconfirmed') {
        expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Couldn't send to"), {
          description: expect.stringContaining(
            "Orca couldn't confirm your message reached the agent"
          )
        })
      }
      cleanup()
    }
  }
)

it('gives static/search no agent actions while loading, retaining settings and generic terminal', () => {
  const model = vi
    .spyOn(menuRows, 'useNewTabAgentMenuRows')
    .mockReturnValue({ state: 'loading', placeholderCount: 2 })
  render(
    <QuickLaunchAgentMenuItems
      worktreeId={WORKTREE_ID}
      groupId="group-1"
      onFocusTerminal={vi.fn()}
    />
  )
  const controller = renderHook(() =>
    useTabBarCreateMenuController({
      worktreeId: WORKTREE_ID,
      resolvedGroupId: 'group-1',
      terminalOnly: false,
      mobileEmulatorEnabled: false,
      managedBrowserCreationEnabled: false,
      mobileEmulatorCreationEnabled: false,
      workspaceHasSimulatorTab: false,
      showWindowsShellMenu: false,
      projectRuntimeShellMenuMode: null,
      defaultWindowsShell: 'powershell',
      defaultWindowsPowerShellImplementation: 'auto',
      agentDetectionTarget: { kind: 'local' },
      windowsTerminalCapabilities: {
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null,
        isLoading: false
      },
      onNewTerminalTab: vi.fn(),
      onNewBrowserTab: vi.fn()
    })
  )
  expect(controller.result.current.agentLaunchOptions).toEqual([])
  expect(
    controller.result.current.createMenuOptions.some((option) => option.kind === 'new-terminal')
  ).toBe(true)
  expect(document.querySelector('[title]')).toBeNull()
  expect(document.body.textContent).toContain('Agent settings')
  model.mockRestore()
})

it('shows the existing inventory failure alongside truthful disabled chat rows', () => {
  render(
    <ProjectedAgentMenuItems
      runLaunch={vi.fn()}
      model={{
        state: 'settled',
        rows: [{ kind: 'chat-unavailable', agent: 'claude', reason: 'check-failed' }],
        detection: {
          detectedIds: null,
          detectionFailed: true,
          needsServerUpdate: false,
          isLoading: false,
          isRefreshing: false,
          refresh: async () => []
        }
      }}
    />
  )
  expect(document.body.textContent).toContain('list terminal agents for this workspace')
  expect(document.body.textContent).toContain('Couldn’t check chat availability')
  expect(document.querySelector('[title]')).toBeNull()
})

function registerLaunch(
  agent: 'claude' | 'codex',
  outcome: 'pending' | 'failed',
  attempt: StructuredLaunchAttempt = {
    kind: 'first',
    requestId: `${agent}-pick`,
    stagedPrompt: null
  }
): void {
  const sessionId = `${agent}-session`
  setStructuredLaunchState({
    identity: `${agent}:${WORKTREE_ID}`,
    intent: {
      worktreeId: WORKTREE_ID,
      sessionId,
      executionHostId: 'local',
      target: { kind: 'local' },
      agent,
      params: {
        envelope: {
          sessionId,
          clientOperationId: `operation-${sessionId}`,
          expectedRuntimeFence: null,
          payloadFingerprint: `fingerprint-${sessionId}`
        },
        worktree: `id:${WORKTREE_ID}`,
        agent
      }
    },
    promptDelivery: undefined,
    callers: {
      outcome,
      attempt,
      entries: new Set(),
      promptDeliveryResults: new Set(),
      onSettled: () => undefined
    },
    promise: new Promise(() => undefined),
    visibilityUnknown: false,
    cancelled: false,
    selection: {}
  } satisfies StructuredLaunchState)
}

function agentRowDisabled(label: string): string {
  const row = screen.getByTitle(`Launch ${label} in a new terminal`)
  expect(row.getAttribute('role')).toBe('menuitem')
  return row.getAttribute('aria-disabled') ?? 'false'
}

describe('QuickLaunchAgentMenuItems launches', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
  })

  it('keeps every agent launchable while chats start, fail or retry', () => {
    registerLaunch('claude', 'pending')
    registerLaunch('codex', 'failed')

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
      />
    )
    expect(agentRowDisabled('Claude')).toBe('false')
    expect(agentRowDisabled('Codex')).toBe('false')
    cleanup()

    registerLaunch('codex', 'pending', { kind: 'retry' })
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
      />
    )
    expect(agentRowDisabled('Codex')).toBe('false')
  })

  it('gives each pick its own request, so a second pick opens its own chat', () => {
    launchMock.mockReset()
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' }
    })
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
      />
    )
    const codexRow = document.querySelector('[title="Launch Codex in a new terminal"]')!
    fireEvent.click(codexRow)
    reopenMenu()
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)

    const requestIds = launchMock.mock.calls.map(([args]) => args.requestId)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toEqual(expect.any(String))
    expect(requestIds[1]).not.toBe(requestIds[0])
  })

  // Why: the notes menu holds what it sent until this result, so a second send leaves them out.
  it('opens the CLI once with notes from the row button, then the row itself starts a chat', async () => {
    vi.spyOn(menuRows, 'useNewTabAgentMenuRows').mockReturnValue({
      state: 'settled',
      rows: [{ kind: 'chat', agent: 'codex', executionHostId: 'runtime:server' }],
      detection: {
        detectedIds: ['codex'],
        detectionFailed: false,
        needsServerUpdate: false,
        isLoading: false,
        isRefreshing: false,
        refresh: async () => ['codex']
      }
    })
    launchMock.mockReset()
    const delivery = Promise.resolve({ delivered: true, failureNotified: false })
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: delivery
    })
    const onPromptHandedOff = vi.fn()

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
        promptDelivery="submit-after-ready"
        onPromptHandedOff={onPromptHandedOff}
      />
    )
    const terminalButton = document.querySelector<HTMLButtonElement>(
      'button[title="Launch Codex in a new terminal"]'
    )!
    terminalButton.focus()
    fireEvent.click(terminalButton)
    terminalButton.blur()

    expect(launchMock).toHaveBeenCalledOnce()
    expect(launchMock.mock.calls[0][0]).toMatchObject({
      requestedSurface: 'terminal',
      selectedExecutionHostId: 'runtime:server'
    })
    expect(launchMock.mock.calls.at(-1)?.[0].prompt).toBe('review notes')
    expect(launchMock.mock.calls.at(-1)?.[0].promptDelivery).toBe('submit-after-ready')
    expect(launchMock.mock.calls.at(-1)?.[0].promptKeptByCaller).toBe(true)
    expect(launchMock.mock.calls.at(-1)?.[0].groupId).toBe('group-1')
    expect(onPromptHandedOff).toHaveBeenCalledOnce()
    await expect(onPromptHandedOff.mock.calls[0][0]).resolves.toEqual({ delivered: true })
    reopenMenu()
    fireEvent.click(document.querySelector('[title="Start a chat with Codex"]')!)
    expect(launchMock).toHaveBeenCalledTimes(2)
    expect(launchMock.mock.calls[1][0]).toMatchObject({
      requestedSurface: 'chat',
      selectedExecutionHostId: 'runtime:server'
    })
  })

  it('tells the notes menu once why its notes did not reach the new agent', async () => {
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: Promise.resolve({
        delivered: false,
        failureNotified: false,
        unconfirmed: true
      })
    })
    toastError.mockClear()

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
        promptDelivery="submit-after-ready"
        onPromptHandedOff={vi.fn()}
      />
    )
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Couldn't send to"), {
      description: expect.stringContaining("Orca couldn't confirm your message reached the agent")
    })
  })

  it("says nothing while a new tab's terminal is still starting", async () => {
    vi.useFakeTimers()
    try {
      launchMock.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'starting-tab' } })
      toastError.mockClear()
      toastMessage.mockClear()
      render(
        <QuickLaunchAgentMenuItems
          worktreeId={WORKTREE_ID}
          groupId="group-1"
          onFocusTerminal={vi.fn()}
        />
      )
      fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(toastMessage).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts no agent when the menu has nothing left to send', () => {
    launchMock.mockClear()
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt=""
        disabled
      />
    )

    expect(agentRowDisabled('Codex')).toBe('true')
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)
    expect(launchMock).not.toHaveBeenCalled()
  })
})

it('forwards configured choices through the existing dispatcher and launch-only Arguments only to terminals', () => {
  launchMock.mockClear()
  launchMock.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'new-tab' } })
  const hook = renderHook(() =>
    useTabAgentMenuLaunch({
      worktreeId: WORKTREE_ID,
      groupId: 'group-1',
      onFocusTerminal: vi.fn()
    })
  )
  const choices = { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' as const }
  hook.result.current(
    { agent: 'codex', kind: 'cli', executionHostId: 'runtime:server' },
    {
      agent: 'codex',
      surface: 'terminal',
      choices,
      arguments: '--add-dir docs'
    }
  )
  expect(launchMock.mock.calls[0][0]).toMatchObject({
    requestedSurface: 'terminal',
    selectedExecutionHostId: 'runtime:server',
    agentArgs: expect.stringContaining('--add-dir docs'),
    sessionOptions: { model: 'astra', effort: 'low', permissionMode: 'ask' }
  })
  hook.result.current(
    { agent: 'codex', kind: 'chat', executionHostId: 'runtime:server' },
    {
      agent: 'codex',
      surface: 'chat',
      choices,
      arguments: '--add-dir docs'
    }
  )
  expect(launchMock.mock.calls[1][0]).toMatchObject({
    requestedSurface: 'chat',
    sessionOptions: { model: 'astra', effort: 'low', permissionMode: 'ask' }
  })
  expect(launchMock.mock.calls[1][0]).not.toHaveProperty('agentArgs')
})
