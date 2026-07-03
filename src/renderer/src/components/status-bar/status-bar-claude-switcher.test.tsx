// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore, type AppState } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { StatusBar } from './StatusBar'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) => {
    if (!values) {
      return fallback
    }
    return Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
  }
}))

vi.mock('./UpdateStatusSegment', () => ({
  UpdateStatusSegment: () => null
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function claudeLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    fableWeekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function selectedClaudeAccountsState(): ClaudeRateLimitAccountsState {
  return {
    accounts: [
      {
        id: 'claude-work',
        email: 'work@example.com',
        managedAuthRuntime: 'host',
        wslDistro: null,
        authMethod: 'subscription-oauth',
        organizationUuid: null,
        organizationName: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeAccountId: 'claude-work',
    activeAccountIdsByRuntime: { host: 'claude-work', wsl: {} }
  }
}

function seedStatusBarStore(): void {
  const settings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [
      {
        id: 'claude-work',
        email: 'work@example.com',
        managedAuthPath: '/tmp/claude-work',
        managedAuthRuntime: 'host' as const,
        wslDistro: null,
        wslLinuxAuthPath: null,
        authMethod: 'subscription-oauth' as const,
        organizationUuid: null,
        organizationName: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    floatingTerminalEnabled: false
  }
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  useAppStore.setState({
    settings,
    statusBarVisible: true,
    statusBarItems: ['claude'],
    detectedAgentIds: ['claude'],
    rateLimits: {
      ...useAppStore.getState().rateLimits,
      claude: claudeLimits(),
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: []
    },
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt1',
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    runtimePaneTitlesByTabId: {},
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'finish account switch',
        updatedAt: 1,
        stateStartedAt: 1,
        agentType: 'claude',
        stateHistory: []
      }
    },
    pendingClaudePaneRestartIds: {},
    claudeRestartNoticeByPtyId: {},
    recordFeatureInteraction: vi.fn(),
    ensureDetectedAgents: vi.fn().mockResolvedValue(undefined),
    refreshRateLimits: vi.fn().mockResolvedValue(undefined),
    refreshDetectedAgents: vi.fn().mockResolvedValue(undefined),
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    fetchInactiveClaudeAccountUsage: vi.fn().mockResolvedValue(undefined)
  })
}

function getButtonByName(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`)
  }
  return button
}

function getText(text: string): HTMLElement {
  const element = Array.from(document.body.querySelectorAll<HTMLElement>('*')).find(
    (candidate) => candidate.textContent?.trim() === text
  )
  if (!element) {
    throw new Error(`Text not found: ${text}`)
  }
  return element
}

function getDialogByName(name: string): HTMLElement {
  const dialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
    (candidate) => candidate.textContent?.includes(name)
  )
  if (!dialog) {
    throw new Error(`Dialog not found: ${name}`)
  }
  return dialog
}

async function clickElement(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
}

async function waitUntil(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown = null
  while (Date.now() - startedAt < 1_000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error('Timed out waiting for assertion')
}

function unmountRenderedStatusBar(rendered: { root: Root; container: HTMLElement } | null): void {
  if (!rendered) {
    return
  }
  act(() => {
    rendered.root.unmount()
  })
  rendered.container.remove()
}

function renderStatusBarSurface(): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <StatusBar floatingTerminalOpen={false} />
      </TooltipProvider>
    )
  })
  return { root, container }
}

function renderStatusBar() {
  return renderStatusBarSurface()
}

describe('StatusBar Claude account switcher', () => {
  let initialStoreState: AppState
  let selectClaudeAccount: ReturnType<typeof vi.fn>
  let renderedStatusBar: { root: Root; container: HTMLElement } | null

  beforeEach(() => {
    initialStoreState = useAppStore.getState()
    renderedStatusBar = null
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    selectClaudeAccount = vi.fn().mockResolvedValue(selectedClaudeAccountsState())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        claudeAccounts: {
          list: vi.fn().mockResolvedValue(selectedClaudeAccountsState()),
          select: selectClaudeAccount
        },
        pty: {
          getForegroundProcess: vi.fn().mockResolvedValue('node'),
          hasChildProcesses: vi.fn().mockResolvedValue(false)
        }
      }
    })
    seedStatusBarStore()
  })

  afterEach(() => {
    unmountRenderedStatusBar(renderedStatusBar)
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useAppStore.setState(initialStoreState, true)
  })

  it('warns before switching accounts when a Claude pane is actively working', async () => {
    renderedStatusBar = renderStatusBar()

    await clickElement(getButtonByName('Open Claude details and account switcher'))
    await clickElement(getText('System default'))
    await clickElement(getText('work@example.com'))

    await waitUntil(() => {
      expect(selectClaudeAccount).not.toHaveBeenCalled()
      expect(getDialogByName('Active Claude work is running').textContent).toContain(
        '1 Claude session appears to be working or waiting for input. Switching accounts will stop and restart it so the new account is used.'
      )
    })

    await clickElement(getButtonByName('Switch and Restart'))

    await waitUntil(() => {
      expect(selectClaudeAccount).toHaveBeenCalledOnce()
      expect(useAppStore.getState().pendingClaudePaneRestartIds).toEqual({ 'pty-1': true })
    })
    expect(selectClaudeAccount).toHaveBeenCalledWith({
      accountId: 'claude-work',
      runtime: 'host',
      wslDistro: null
    })
  })
})
