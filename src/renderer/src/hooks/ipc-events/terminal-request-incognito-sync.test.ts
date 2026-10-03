// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreateRequestPayload } from '../../../../shared/runtime-terminal-contracts'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(
    (
      _worktreeId: string,
      _groupId: string | undefined,
      _shellOverride: string | undefined,
      options?: { incognito?: boolean }
    ) => ({ id: 'tab-1', incognito: options?.incognito })
  ),
  requestBackgroundTerminalWorktreeMount: vi.fn(),
  replyTerminalCreate: vi.fn()
}))

vi.mock('@/lib/terminal-worktree-route', () => ({
  // A local (non-remote) route so the bridge proceeds to createTab.
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: undefined })
}))
vi.mock('./terminal-command-state', () => ({
  resolveTerminalPresentation: () => 'background',
  activateTerminalInitiatedWorktree: vi.fn(),
  focusTerminalInitiatedTab: vi.fn()
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.requestBackgroundTerminalWorktreeMount
}))
vi.mock('@/lib/native-chat-initial-view-mode', () => ({ initialAgentTabViewModeProps: () => ({}) }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => false
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/unified-tab-anchor-insertion', () => ({ insertUnifiedTabAfterAnchor: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: 'repo::/wt',
      createTab: mocks.createTab,
      unifiedTabsByWorktree: {},
      settings: {}
    })
  }
}))

import { registerTerminalRequestIpcBridge } from './terminal-request-ipc-bridge'

function captureHandler(): (data: RuntimeTerminalCreateRequestPayload) => void {
  let handler!: (data: RuntimeTerminalCreateRequestPayload) => void
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    ui: {
      onRequestTerminalCreate: (cb: (data: RuntimeTerminalCreateRequestPayload) => void) => {
        handler = cb
        return () => {}
      },
      replyTerminalCreate: mocks.replyTerminalCreate
    }
  }
  registerTerminalRequestIpcBridge([])
  return handler
}

describe('terminal-request bridge incognito sync', () => {
  beforeEach(() => {
    mocks.createTab.mockClear()
    mocks.replyTerminalCreate.mockClear()
  })

  it('drives tab.incognito from the host-authoritative incognito flag', () => {
    const handler = captureHandler()

    handler({
      requestId: 'req-1',
      worktreeId: 'repo::/wt',
      presentation: 'background',
      incognito: true
    } as RuntimeTerminalCreateRequestPayload)

    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    const options = mocks.createTab.mock.calls[0][3]
    expect(options).toMatchObject({ incognito: true })
    expect(mocks.createTab.mock.results[0].value).toMatchObject({ incognito: true })
  })

  it('leaves the tab non-incognito when the host omits the flag', () => {
    const handler = captureHandler()

    handler({
      requestId: 'req-2',
      worktreeId: 'repo::/wt',
      presentation: 'background'
    } as RuntimeTerminalCreateRequestPayload)

    const options = mocks.createTab.mock.calls[0][3]
    expect(options?.incognito).toBeUndefined()
  })

  it('forwards an explicit host false so it overrides createTab’s per-agent default', () => {
    const handler = captureHandler()

    // The host resolved an explicit opt-out (`--no-session false` over a per-agent default). It must
    // reach createTab as `false`, not be dropped — otherwise createTab recomputes the default (true)
    // and wrongly stamps the tab incognito.
    handler({
      requestId: 'req-3',
      worktreeId: 'repo::/wt',
      presentation: 'background',
      incognito: false
    } as RuntimeTerminalCreateRequestPayload)

    const options = mocks.createTab.mock.calls[0][3]
    expect(options).toMatchObject({ incognito: false })
  })
})
