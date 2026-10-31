// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithoutApp,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '@/runtime/remote-runtime-terminal-multiplexer-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { resetRemoteRuntimeTerminalPreviewSessionsForTests } from './remote-runtime-terminal-preview-api'
import {
  installPreviewDomFixture,
  mountPreviewLinkInteraction
} from './dashboard-preview-dom-test-fixture'
import { verifyPreviewLinkPopulation } from './dashboard-preview-link-population-test-fixture'
import { verifyPopoutDefaultLinkPath } from './dashboard-preview-popout-default-test-fixture'
import { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { runtimeStatuses } from '@/store/slices/browser-slice-test-harness'
import { openStandaloneTerminal } from '../standalone-terminal/open-standalone-terminal'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { getDefaultSettings } from '../../../../shared/constants'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '@/lib/browser-link-open.test-fixture'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/http-link-routing'
import { openWorkspaceBrowserTabForLink } from '@/lib/workspace-browser-tab-open'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { terminalPreviewApiFor } from './terminal-preview-api'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { AgentTerminalPanel } from './AgentTerminalDialog'
import { handleTerminalHttpLink } from '@/components/terminal-pane/terminal-url-link-hit-testing'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DashboardPreviewLinkSource } from './dashboard-preview-http-actions'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  subscribe: vi.fn(),
  remote: new Map<string, RemoteRuntimeMultiplexedTerminalCallbacks>()
}))
vi.mock('@/runtime/remote-runtime-terminal-multiplexer', () => ({
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
}))
function render(ui: React.ReactElement) {
  return renderWithoutApp(ui, { wrapper: TooltipProvider })
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: ReturnType<typeof mocks.getState>) => unknown) => selector(mocks.getState()),
    { getState: mocks.getState }
  )
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))
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

it('uses the real Dashboard constructor, OSC primer/provider and genuine claim; context Copy and live destinations share the same URI', async () => {
  const foreground = vi.fn()
  const view = render(
    <AgentTerminalPreview ptyId="pty-1" linkSource={source} onBrowserForeground={foreground} />
  )
  await waitFor(() => screenFor(view.container))
  await output(`\x1b[?1000h\x1b[?1006h${osc}`)
  const screen = screenFor(view.container)
  // No hover is delivered: actual capture priming must discover the hidden OSC label.
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  await waitFor(() => expect(document.querySelector('[data-link-action-popover]')).not.toBeNull())
  expect(document.querySelector('[data-terminal-link-destination]')?.textContent).toBe(URL_TO_OPEN)
  expect(
    input.mock.calls.flatMap(([, data]) => data).filter((data) => data.startsWith('\x1b[<'))
  ).toEqual([])
  fireEvent.click(view.getByRole('button', { name: 'Copy link' }))
  await waitFor(() => expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(URL_TO_OPEN))
  fireEvent.click(view.getByRole('button', { name: /System Browser/ }))
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN))
  expect(foreground).not.toHaveBeenCalled()

  store.setState((state) => ({ settings: { ...state.settings!, openLinksInApp: true } }))
  view.rerender(
    <AgentTerminalPreview ptyId="pty-1" linkSource={source} onBrowserForeground={foreground} />
  )
  pointer(screen, 'mousemove')
  pointer(screen, 'contextmenu', { button: 2, buttons: 0 })
  await waitFor(() => expect(view.getByRole('button', { name: /Orca Browser/ })).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: /Orca Browser/ }))
  await waitFor(() => expect(foreground).toHaveBeenCalledOnce())
  expect(store.getState().browserPagesByWorkspace).not.toEqual({})
  view.unmount()
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
})

it.each(['actions', 'open'] as const)(
  'retains the provider-owned hidden OSC target across unrelated live row output for %s and context',
  async (behavior) => {
    store.setState((state) => ({
      settings: { ...state.settings!, terminalLinkClickBehavior: behavior }
    }))
    const view = render(<AgentTerminalPreview ptyId="pty-1" linkSource={source} />)
    await waitFor(() => screenFor(view.container))
    await output(`\x1b[?1000h\x1b[?1006h${osc}\x1b[3;1Hprogress 1`)
    const screen = screenFor(view.container)
    const terminal = view.container.querySelector('.xterm')!
    pointer(screen, 'mousemove', { buttons: 0 })
    await waitFor(() => expect(terminal.getAttribute('title')).toBe(URL_TO_OPEN))
    await output('\x1b[3;1Hprogress 2')
    await waitFor(() => expect(view.container.textContent).toContain('progress 2'))
    expect(terminal.getAttribute('title')).toBe(URL_TO_OPEN)
    // Keep the pointer stationary: the retained provider does not emit another hover.
    pointer(screen, 'mousedown')
    pointer(screen, 'mouseup')
    if (behavior === 'actions') {
      const system = await view.findByRole('button', { name: /System Browser/ })
      expect(document.querySelector('[data-terminal-link-destination]')?.textContent).toBe(
        URL_TO_OPEN
      )
      fireEvent.click(system)
    }
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(URL_TO_OPEN))
    expect(input.mock.calls.map(([, data]) => data)).toEqual([])
    await output('\x1b[3;1Hprogress 3')
    const context = pointer(screen, 'contextmenu', { button: 2, buttons: 0 })
    expect(context.defaultPrevented).toBe(true)
    const copy = await view.findByRole('button', { name: 'Copy link' })
    expect(document.querySelector('[data-terminal-link-destination]')?.textContent).toBe(
      URL_TO_OPEN
    )
    fireEvent.click(copy)
    await waitFor(() => expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(URL_TO_OPEN))
    pointer(screen, 'mouseleave', { buttons: 0 })
    expect(terminal.hasAttribute('title')).toBe(false)
  }
)

function seedRemoteWorkspace(
  hostId: ExecutionHostId,
  environmentId: string,
  streaming: boolean
): void {
  store.setState((state) => ({
    activeWorkspaceExecutionHostId: hostId,
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((row) => ({
        ...row,
        hostId,
        runtimeOwnerEnvironmentId: environmentId
      }))
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: hostId
      }))
    },
    runtimeStatusByEnvironmentId: new Map([
      [environmentId, runtimeStatuses(streaming ? ['browser.screencast.v1'] : []).get('env-1')!]
    ]),
    settings: { ...state.settings!, browserClientHostedRemoteEnabled: false, openLinksInApp: true }
  }))
}

it.each([false, true])(
  'keeps paired SSH OSC actions system-only with exact Copy despite the in-app preference (streaming=%s)',
  async (streaming) => {
    const hostId = 'ssh:private-target'
    const ptyId = 'remote:hub-a@@handle-1'
    const linkSource = {
      ...source,
      executionHostId: hostId,
      ptyId
    } satisfies DashboardPreviewLinkSource
    const foreground = vi.fn()
    seedRemoteWorkspace(hostId, 'hub-a', streaming)
    const props = { ptyId, linkSource, onBrowserForeground: foreground }
    const connect = vi.spyOn(terminalPreviewApiFor(ptyId), 'connect')
    const view = render(<AgentTerminalPreview {...props} />)
    await waitFor(() => screenFor(view.container))
    await output(osc, ptyId)
    const screen = screenFor(view.container)
    pointer(screen, 'mousedown')
    pointer(screen, 'mouseup')
    const system = await view.findByRole('button', { name: /System Browser/ })
    expect(view.queryByRole('button', { name: /Orca Browser|Open in this group/ })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(URL_TO_OPEN))
    fireEvent.click(system)
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(URL_TO_OPEN))
    pointer(screen, 'mousedown', { ctrlKey: true })
    pointer(screen, 'mouseup', { ctrlKey: true })
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))
    expect(foreground).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    const wrongPtyId = 'remote:hub-b@@handle-1'
    view.rerender(
      <AgentTerminalPreview
        {...props}
        ptyId={wrongPtyId}
        linkSource={{ ...linkSource, ptyId: wrongPtyId }}
      />
    )
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await output(osc, wrongPtyId)
    const wrongScreen = screenFor(view.container)
    pointer(wrongScreen, 'mousedown', { ctrlKey: true })
    pointer(wrongScreen, 'mouseup', { ctrlKey: true })
    pointer(wrongScreen, 'contextmenu', { button: 2 })
    expect(document.querySelector('[data-link-action-popover]')).toBeNull()
    expect(openUrl).toHaveBeenCalledTimes(2)
  }
)

it('gives one useful refusal when a real saved chooser action loses runtime browser eligibility', async () => {
  const hostId = 'runtime:e'
  const ptyId = 'remote:e@@handle-1'
  const linkSource = {
    ...source,
    executionHostId: hostId,
    ptyId
  } satisfies DashboardPreviewLinkSource
  const foreground = vi.fn()
  seedRemoteWorkspace(hostId, 'e', true)
  const props = { ptyId, linkSource, onBrowserForeground: foreground }
  const view = render(<AgentTerminalPreview {...props} />)
  await waitFor(() => screenFor(view.container))
  await output(osc, ptyId)
  const screen = screenFor(view.container)
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  const savedAction = await view.findByRole('button', { name: /Orca Browser/ })
  // Actual failed-status refresh shape, after the real request has captured its action.
  store.setState({ runtimeStatusByEnvironmentId: new Map([['e', { status: null, checkedAt: 2 }]]) })
  fireEvent.click(savedAction)
  await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('Unable to open URL.'))
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(openUrl).not.toHaveBeenCalled()
  expect(foreground).not.toHaveBeenCalled()
  expect(input.mock.calls.map(([, data]) => data)).toEqual([])
})

it('keeps None/middle/drag/nonlink reports and ordinary input live, refuses parser queries, and leaves native/paste context alone', async () => {
  store.setState((state) => ({
    settings: { ...state.settings!, terminalLinkClickBehavior: 'none' }
  }))
  const view = render(<AgentTerminalPreview ptyId="pty-1" linkSource={source} />)
  await waitFor(() => screenFor(view.container))
  await output(`\x1b[?1000h\x1b[?1006h${URL_TO_OPEN}`)
  const screen = screenFor(view.container)
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  pointer(screen, 'mousedown', { button: 1, buttons: 4 })
  pointer(screen, 'mouseup', { button: 1 })
  await waitFor(() =>
    expect(input.mock.calls.some(([, data]) => data.startsWith('\x1b[<0;'))).toBe(true)
  )
  expect(input.mock.calls.map(([, data]) => data)).toEqual([
    '\x1b[<0;1;1M',
    '\x1b[<0;1;1m',
    '\x1b[<1;1;1M',
    '\x1b[<1;1;1m'
  ])
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
  expect(openUrl).not.toHaveBeenCalled()
  const prior = input.mock.calls.length
  await output('\x1b[6n')
  expect(input).toHaveBeenCalledTimes(prior)
  const textarea = view.container.querySelector('textarea')!
  fireEvent.keyDown(textarea, { key: 'x', code: 'KeyX', keyCode: 88 })
  fireEvent.input(textarea, { data: 'x', inputType: 'insertText' })
  await waitFor(() => expect(input).toHaveBeenCalledWith('pty-1', 'x'))
  const native = pointer(screen, 'contextmenu', { button: 2, ctrlKey: true })
  expect(native.defaultPrevented).toBe(false)
  store.setState((state) => ({ settings: { ...state.settings!, terminalRightClickToPaste: true } }))
  view.rerender(<AgentTerminalPreview ptyId="pty-1" linkSource={source} />)
  textarea.focus()
  pointer(screen, 'contextmenu', { button: 2 })
  await waitFor(() => expect(window.api.ui.readClipboardText).toHaveBeenCalled())
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
})

it.each([false, true])(
  'preserves standalone normal/SSH defaults and sole-emulator query policy (answersQueries=%s)',
  async (answersQueries) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const send = vi.fn(() => true)
    const instance = openStandaloneTerminal({
      container,
      options: { cols: 80, rows: 8, allowProposedApi: true },
      kittyKeyboardModes: new TerminalKittyKeyboardModeTracker({ kittyKeyboard: true }),
      sessionKey: 'plain-ssh:test',
      sendInput: send,
      answersQueries,
      getSettings: () => store.getState().settings,
      getMacOptionAsAlt: () => 'false',
      getTerminalInput: () => null
    })
    instances.push(instance)
    if (!instance) {
      throw new Error('Real constructor refused test layout')
    }
    const terminal = instance.terminal
    await new Promise<void>((resolve) =>
      instance.write(`${osc}\r\n${URL_TO_OPEN}\x1b[6n`, { live: true, onDone: resolve })
    )
    expect(send.mock.calls.length > 0).toBe(answersQueries)
    terminal.input('ordinary')
    expect(send).toHaveBeenLastCalledWith('ordinary')
    const screen = screenFor(container)
    pointer(screen, 'mousemove', { buttons: 0 })
    await waitFor(() => expect(terminal.element?.getAttribute('title')).toBe(URL_TO_OPEN))
    pointer(screen, 'mousedown', { ctrlKey: true })
    pointer(screen, 'mouseup', { ctrlKey: true })
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN))
    expect(terminal.hasSelection()).toBe(false)
    expect(terminal.element?.getAttribute('title')).toBe(URL_TO_OPEN)
    pointer(screen, 'mouseleave')
    expect(terminal.element?.getAttribute('title')).toBeNull()
    // The same default callback is captured by the detected-URL provider, not only OSC.
    pointer(screen, 'mousemove', { clientY: 27 })
    pointer(screen, 'mousedown', { ctrlKey: true, clientY: 27 })
    pointer(screen, 'mouseup', { ctrlKey: true, clientY: 27 })
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual([URL_TO_OPEN, URL_TO_OPEN])
    pointer(screen, 'mousedown', { clientY: 27 })
    pointer(screen, 'mouseup', { clientY: 27 })
    expect(openUrl).toHaveBeenCalledTimes(2)
    const injected = mountedInteraction()
    const injectedInteraction = injected.install()
    const raw = 'https:example.com'
    for (const current of [instance, injected.instance]) {
      const term = current.terminal
      const target = screenFor(term.element!.parentElement!)
      pointer(target, 'mouseleave')
      await new Promise<void>((resolve) =>
        current.write(`\x1b[2J\x1b[H\x1b]8;;${raw}\x07Link\x1b]8;;\x07`, {
          live: true,
          onDone: resolve
        })
      )
      pointer(target, 'mousemove', { buttons: 0 })
      await waitFor(() => expect(term.element?.getAttribute('title')).toBe(raw))
      term.select(0, 0, 4)
      const clear = vi.spyOn(term, 'clearSelection')
      pointer(target, 'mousedown', { ctrlKey: true })
      pointer(target, 'mouseup', { ctrlKey: true })
      await waitFor(() => expect(openUrl).toHaveBeenLastCalledWith(raw))
      expect(clear).toHaveBeenCalled()
      expect(term.hasSelection()).toBe(false)
      clear.mockRestore()
    }
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual([URL_TO_OPEN, URL_TO_OPEN, raw, raw])
    expect(injected.request).not.toHaveBeenCalled()
    expect(document.querySelector('[data-link-action-popover]')).toBeNull()
    injectedInteraction.dispose()
    instance.dispose()
    container.remove()
  }
)

function mountedInteraction() {
  return mountPreviewLinkInteraction(
    source,
    () => store.getState().settings,
    (instance) => instances.push(instance)
  )
}

it.each([10, 100])(
  'bounds actual registration, document callbacks and target input/output at P=%s; reset/dispose leave zero adapter residue',
  async (population) => {
    await verifyPreviewLinkPopulation(
      population,
      source,
      () => store.getState().settings,
      (instance) => instances.push(instance),
      osc,
      URL_TO_OPEN,
      pointer,
      screenFor
    )
  }
)

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

it('adds no provider or preview connection when the real board grows from 10 to 100 cards without an open preview', async () => {
  const provider = vi.spyOn(Terminal.prototype, 'registerLinkProvider')
  const view = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: cards(10) }} />)
  view.rerender(<AgentKanbanBoard snapshot={{ generatedAt: 2, cards: cards(100) }} />)
  expect(provider).not.toHaveBeenCalled()
  expect(window.api.terminalPreview.connect).not.toHaveBeenCalled()
  view.unmount()
  await verifyPopoutDefaultLinkPath({
    source,
    card: { ...cards(1)[0]!, ...source },
    provider,
    osc,
    readSettings: () => store.getState().settings,
    trackInstance: (instance) => instances.push(instance),
    pointer,
    screenFor,
    output,
    input,
    openUrl,
    subscribeToRouter: mocks.subscribe
  })
})

it('honors primary/alternate and Open on real literal URLs, keeps background context, and refuses unqualified/mismatched hosts before feedback', async () => {
  store.setState((state) => ({
    settings: { ...state.settings!, openLinksInApp: true, terminalLinkClickBehavior: 'open' }
  }))
  const foreground = vi.fn()
  const view = render(
    <AgentTerminalPreview ptyId="pty-1" linkSource={source} onBrowserForeground={foreground} />
  )
  await waitFor(() => screenFor(view.container))
  await output(URL_TO_OPEN)
  const screen = screenFor(view.container)
  // First literal click exercises the fallback when the provider has not finished hover discovery.
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  await waitFor(() => expect(foreground).toHaveBeenCalledOnce())
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
  expect(openUrl).not.toHaveBeenCalled()
  pointer(screen, 'mousedown', { ctrlKey: true, shiftKey: true })
  pointer(screen, 'mouseup', { ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(URL_TO_OPEN))
  expect(foreground).toHaveBeenCalledOnce()
  store.setState((state) => ({
    settings: { ...state.settings!, openLinksInAppInBackground: true }
  }))
  view.rerender(
    <AgentTerminalPreview ptyId="pty-1" linkSource={source} onBrowserForeground={foreground} />
  )
  const observed = mocks.subscribe.mock.calls.length
  pointer(screen, 'mousedown', { ctrlKey: true })
  pointer(screen, 'mouseup', { ctrlKey: true })
  await waitFor(() => expect(mocks.subscribe.mock.results[observed]?.value).toHaveBeenCalledOnce())
  expect(foreground).toHaveBeenCalledOnce()
  view.rerender(
    <AgentTerminalPreview
      ptyId="pty-1"
      linkSource={{ ...source, executionHostId: undefined }}
      onBrowserForeground={foreground}
    />
  )
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  expect(document.querySelector('[data-link-action-popover]')).toBeNull()
  expect(openUrl).toHaveBeenCalledTimes(1)
  const remotePty = 'ssh:other@@pty-1'
  view.rerender(
    <AgentTerminalPreview
      ptyId={remotePty}
      linkSource={{ ...source, ptyId: remotePty, executionHostId: 'ssh:other' }}
      onBrowserForeground={foreground}
    />
  )
  await waitFor(() => expect(window.api.terminalPreview.connect).toHaveBeenCalledTimes(2))
  await output(URL_TO_OPEN, remotePty)
  pointer(screenFor(view.container), 'contextmenu', { button: 2 })
  // This real-shaped remote card has no eligible managed-browser route in the local-only workspace.
  await waitFor(() => expect(view.getByRole('button', { name: /System Browser/ })).toBeTruthy())
  expect(view.queryByRole('button', { name: /Orca Browser/ })).toBeNull()
})

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

it('hands Settings through the actual in-window frame and shared popover without leaving the covering panel open', async () => {
  const close = vi.fn()
  const handoff = vi.fn()
  const card = {
    ...cards(1)[0]!,
    ...source,
    paneKey: 'pane-1',
    leafId: 'leaf-1',
    worktreeName: 'Workspace'
  }
  const view = render(
    <AgentTerminalPanel
      card={card}
      onOpenChange={close}
      onReveal={vi.fn()}
      onBrowserForeground={handoff}
    />
  )
  await waitFor(() => screenFor(view.container))
  await output(osc)
  const screen = screenFor(view.container)
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Terminal link settings' })).toBeTruthy()
  )
  fireEvent.click(view.getByRole('button', { name: 'Terminal link settings' }))
  expect(close).toHaveBeenCalledExactlyOnceWith(false)
  expect(handoff).toHaveBeenCalledOnce()
  expect(store.getState().activeView).toBe('settings')
})

it.each(['local', 'unknown'] as const)(
  'keeps the common pane route and real Dashboard route destination/refusal equivalent for source=%s',
  async (owner) => {
    store.setState((state) => ({ settings: { ...state.settings!, openLinksInApp: false } }))
    handleTerminalHttpLink(URL_TO_OPEN, new MouseEvent('mouseup', { button: 0, ctrlKey: true }), {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      sourceOwner: owner === 'local' ? { kind: 'local' } : { kind: 'unknown' },
      actionDestinations: { primary: 'system' }
    })
    const expected = owner === 'local' ? [URL_TO_OPEN] : []
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(expected)
    openUrl.mockClear()
    const view = render(
      <AgentTerminalPreview
        ptyId="pty-1"
        linkSource={{ ...source, executionHostId: owner === 'local' ? 'local' : undefined }}
        onBrowserForeground={vi.fn()}
      />
    )
    await waitFor(() => screenFor(view.container))
    await output(osc)
    const screen = screenFor(view.container)
    pointer(screen, 'mousedown', { ctrlKey: true })
    pointer(screen, 'mouseup', { ctrlKey: true })
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(expected)
    expect(document.querySelector('[data-link-action-popover]')).toBeNull()
  }
)
