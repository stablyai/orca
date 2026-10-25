// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchState } from '@/lib/structured-agent-session-launch-registry'
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
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    title,
    onSelect
  }: { children: ReactNode } & DivProps) => (
    <div aria-disabled={disabled ? 'true' : 'false'} title={title} onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
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

type DivProps = { disabled?: boolean; title?: string; onSelect?: () => void }

import { QuickLaunchAgentMenuItems, ProjectedAgentMenuItems } from './QuickLaunchButton'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import * as menuRows from './use-new-tab-agent-menu-rows'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/structured-agent-session-launch-registry'

const WORKTREE_ID = 'worktree-1'

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
    selection: { held: {} }
  } satisfies StructuredLaunchState)
}

function agentRowDisabled(label: string): string | null | undefined {
  return document
    .querySelector(`[title="Launch ${label} in a new terminal"]`)
    ?.getAttribute('aria-disabled')
}

describe('QuickLaunchAgentMenuItems launches', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
  })
  afterEach(cleanup)

  // Each pick is its own request, so a chat starting, failing or retrying never blocks one.
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
    fireEvent.click(codexRow)

    const requestIds = launchMock.mock.calls.map(([args]) => args.requestId)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toEqual(expect.any(String))
    expect(requestIds[1]).not.toBe(requestIds[0])
  })

  // Why: the notes menu holds what it sent until this result, so a second send leaves them out.
  it('opens the CLI once with notes from the row button, then the row itself starts a chat', async () => {
    const model = vi.spyOn(menuRows, 'useNewTabAgentMenuRows').mockReturnValueOnce({
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
    model.mockRestore()
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
    fireEvent.click(document.querySelector('[title="Start a chat with Codex"]')!)
    expect(launchMock).toHaveBeenCalledTimes(2)
    expect(launchMock.mock.calls[1][0]).toMatchObject({
      requestedSurface: 'chat',
      selectedExecutionHostId: 'runtime:server'
    })
  })

  // The notes keep their text, so they are the one place that says it did not go.
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

  // Why: the pane's own spawn reports a real failure; a terminal still starting is not one.
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
