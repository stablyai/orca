// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithoutApp,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '@/runtime/hosted-terminals/streams/remote-terminal-stream-contracts'

import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { resetRemoteRuntimeTerminalPreviewSessionsForTests } from './remote-runtime-terminal-preview-api'
import {
  installPreviewDomFixture,
  mountPreviewLinkInteraction
} from './dashboard-preview-dom-test-fixture'

import type { openStandaloneTerminal } from '../standalone-terminal/open-standalone-terminal'

import { getDefaultSettings } from '../../../../shared/constants'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '@/lib/browser/navigation/browser-link-open.test-fixture'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/browser/navigation/http-link-routing'
import { openWorkspaceBrowserTabForLink } from '@/lib/browser/workspace/workspace-browser-tab-open'

import { terminalPreviewApiFor } from './terminal-preview-api'
import { AgentKanbanBoard } from './AgentKanbanBoard'

import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  subscribe: vi.fn(),
  remote: new Map<string, RemoteRuntimeMultiplexedTerminalCallbacks>()
}))
vi.mock(
  '@/runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry',
  () => ({
    getRemoteRuntimeTerminalMultiplexer: (environmentId: string) => ({
      subscribeTerminal: async ({
        terminal,
        callbacks
      }: {
        terminal: string
        callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
      }) => {
        const ptyId = `remote:${environmentId}@@${terminal}`
        mocks.remote.set(ptyId, callbacks)
        queueMicrotask(() => callbacks.onSnapshot('', { cols: 80, rows: 8, seq: 1 }))
        return {
          sendInput: (data: string) => input(ptyId, data),
          claimViewport: () => true,
          serializeBufferOutcome: async () => ({
            availability: { kind: 'snapshot' },
            snapshot: { data: '', cols: 80, rows: 8, seq: 1 }
          }),
          close: () => {
            mocks.remote.delete(ptyId)
          }
        }
      }
    })
  })
)

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: ReturnType<typeof mocks.getState>) => unknown) => selector(mocks.getState()),
    { getState: mocks.getState }
  )
}))
vi.mock('@/hooks/theme/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
const domWindow = window
const api = createStoreCascadesMockApi()
Object.assign(globalThis, { window: domWindow })
Object.assign(window, { api })
let store: ReturnType<typeof createBrowserLinkTestStore>
const instances: ReturnType<typeof openStandaloneTerminal>[] = []
const input = vi.fn(async (_pty: string, _data: string) => true)
const openUrl = vi.fn(async (_url: string) => {})
let onData: ((payload: unknown) => void) | undefined
let disposeDom: () => void
const source = {
  worktreeId: WORKSPACE,
  executionHostId: 'local',
  tabId: 'source',
  ptyId: 'pty-1'
} as const

beforeEach(() => {
  store = createBrowserLinkTestStore()
  store.setState((state) => ({
    settings: {
      ...state.settings,
      ...getDefaultSettings('/home/test'),
      terminalLigatures: 'auto',
      terminalLinkClickBehavior: 'actions',
      terminalRightClickToPaste: false,
      openLinksInApp: false
    } satisfies GlobalSettings
  }))
  mocks.getState.mockImplementation(() => store.getState())
  mocks.subscribe.mockImplementation((listener) => vi.fn(store.subscribe(listener)))
  registerHttpLinkStoreAccessor(() => store.getState(), mocks.subscribe)
  registerWorkspaceHttpLinkBrowserOpener(async (request) => {
    if (!request.linkContext) {
      throw new Error('Expected a genuine link request')
    }
    const outcome = await openWorkspaceBrowserTabForLink({
      ...request,
      linkContext: request.linkContext
    })
    return outcome.status === 'opened' ? outcome.result.browserPageId : null
  })
  disposeDom = installPreviewDomFixture()
  Object.assign(window.api, {
    shell: { ...window.api.shell, openUrl },
    dashboard: {
      ...window.api.dashboard,
      ackAgent: vi.fn(async (_pane: string, _intent: 'view' | 'explicit') => {})
    },
    terminalPreview: {
      connect: vi.fn(async () => ({
        snapshot: { data: '', cols: 80, rows: 8, seq: 1 },
        replay: []
      })),
      onData: (listener: typeof onData) => {
        onData = listener
        return () => {
          onData = undefined
        }
      },
      input,
      ack: vi.fn(async () => {}),
      fit: vi.fn(async () => ({ cols: 80, rows: 8 })),
      unsubscribe: vi.fn(async () => {})
    },
    ui: {
      ...window.api.ui,
      readClipboardText: vi.fn(async () => 'clipboard'),
      writeClipboardText: vi.fn(async () => {}),
      writeTerminalClipboardText: vi.fn(async () => {})
    }
  })
})
afterEach(() => {
  cleanup()
  for (const instance of instances.splice(0)) {
    instance?.dispose()
  }
  registerWorkspaceHttpLinkBrowserOpener(null)
  resetRemoteRuntimeTerminalPreviewSessionsForTests()
  disposeDom()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function screenFor(container: HTMLElement): HTMLElement {
  const screen = container.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) {
    throw new Error('Actual xterm screen did not mount')
  }
  return screen
}
function pointer(screen: HTMLElement, type: string, options: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    clientX: 7,
    clientY: 7,
    ...options
  })
  screen.dispatchEvent(event)
  return event
}
async function output(data: string, ptyId = 'pty-1') {
  const ack = vi.spyOn(terminalPreviewApiFor(ptyId), 'ack').mockClear()
  act(() => {
    if (parseRemoteRuntimePtyId(ptyId)) {
      const callbacks = mocks.remote.get(ptyId)
      if (!callbacks) {
        throw new Error('Missing selected remote preview subscription')
      }
      callbacks.onData(data)
    } else {
      onData?.({ type: 'data', ptyId, data, bytes: data.length })
    }
  })
  await waitFor(() => expect(ack).toHaveBeenCalledExactlyOnceWith(ptyId, data.length))
}
const osc = `\x1b]8;;${URL_TO_OPEN}\x07hidden label\x1b]8;;\x07`

function mountedInteraction() {
  return mountPreviewLinkInteraction(
    source,
    () => store.getState().settings,
    (instance) => instances.push(instance)
  )
}

it('retains actual boolean/Promise forwarding results and flushes unclaimed reports in order, with finite overflow and cleanup', async () => {
  const preview = mountedInteraction()
  const interaction = preview.install()
  preview.sink.mockReturnValueOnce(false)
  expect(interaction.sendInput('refused-key')).toBe(false)
  const promise = Promise.resolve(true)
  preview.sink.mockReturnValueOnce(promise)
  expect(interaction.sendInput('async-key')).toBe(promise)
  await new Promise<void>((resolve) => preview.instance.write(osc, { live: true, onDone: resolve }))
  const screen = screenFor(preview.container)
  const reports = Array.from({ length: 65 }, (_, i) => `\x1b[<0;${i + 1};1M`)
  // Protocol fixture feeds qualified input during a real event dispatch; native timing remains QA's separate obligation.
  const emitReports = () => {
    preview.instance.terminal.input(reports[0]!)
    expect(preview.sink).toHaveBeenCalledTimes(2)
    for (const report of reports.slice(1)) {
      preview.instance.terminal.input(report)
    }
  }
  screen.addEventListener('mousedown', emitReports)
  pointer(screen, 'mousedown')
  screen.removeEventListener('mousedown', emitReports)
  pointer(screen, 'mouseup')
  expect(preview.sink.mock.calls.slice(2).map(([data]) => data)).toEqual(reports)
  expect(preview.request).not.toHaveBeenCalled()
  interaction.dispose()
  expect(preview.sink.mock.calls.slice(2).map(([data]) => data)).toEqual(reports)
})

function cards(count: number): DashboardCard[] {
  return Array.from({ length: count }, (_, i) => ({
    paneKey: `pane-${i}`,
    ptyId: `pty-${i}`,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'task',
    repoId: 'repo1',
    worktreeId: WORKSPACE,
    tabId: `tab-${i}`,
    leafId: `leaf-${i}`,
    repoName: 'Repo',
    worktreeName: `Workspace ${i}`,
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false
  }))
}

it('refuses real selected/drag/nonlink reports and retains the real in-window Board chooser and Settings handoff', async () => {
  const preview = mountedInteraction()
  const interaction = preview.install()
  await new Promise<void>((resolve) =>
    preview.instance.write(`\x1b[?1000h\x1b[?1006h${URL_TO_OPEN}`, { live: true, onDone: resolve })
  )
  const terminal = preview.instance.terminal
  const screen = screenFor(preview.container)
  terminal.select(0, 0, 5)
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  expect(preview.request).not.toHaveBeenCalled()
  terminal.clearSelection()
  pointer(screen, 'mousedown')
  pointer(screen, 'mousemove', { clientX: 30 })
  pointer(screen, 'mouseup', { clientX: 30 })
  expect(preview.request).not.toHaveBeenCalled()
  pointer(screen, 'mousedown', { clientX: 700 })
  pointer(screen, 'mouseup', { clientX: 700 })
  expect(preview.request).not.toHaveBeenCalled()
  const reports = expect.poll(() => preview.sink.mock.calls.map(([data]) => data))
  await reports.toEqual([
    '\x1b[<0;1;1M',
    '\x1b[<0;1;1m',
    '\x1b[<0;1;1M',
    '\x1b[<0;4;1m',
    '\x1b[<0;71;1M',
    '\x1b[<0;71;1m'
  ])
  interaction.dispose()
  preview.instance.dispose()
  preview.container.remove()

  const foreground = vi.fn()
  const view = renderWithoutApp(
    <AgentKanbanBoard
      snapshot={{ generatedAt: 1, cards: [{ ...cards(1)[0]!, ...source }] }}
      onBrowserForeground={foreground}
    />
  )
  fireEvent.click(view.getByRole('button', { name: /Workspace 0/ }))
  await waitFor(() => screenFor(document.body))
  await output(osc)
  const realScreen = screenFor(document.body)
  pointer(realScreen, 'mousedown')
  pointer(realScreen, 'mouseup')
  const settings = await view.findByRole('button', { name: 'Terminal link settings' })
  expect(document.querySelector('[data-terminal-link-destination]')?.textContent).toBe(URL_TO_OPEN)
  expect(view.getByRole('button', { name: /System Browser/ })).toBeTruthy()
  fireEvent.click(settings)
  expect(foreground).toHaveBeenCalledOnce()
  expect(store.getState().activeView).toBe('settings')
  await waitFor(() => expect(document.querySelector('.xterm')).toBeNull())
})
