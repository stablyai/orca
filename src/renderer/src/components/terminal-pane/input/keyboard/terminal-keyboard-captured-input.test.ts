// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import {
  registerPtySerializer,
  registerPtyTitleSource
} from '../../snapshots/pty-buffer-serializer'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_START_EVENT,
  XTERM_COMPOSITION_SESSION_END_EVENT
} from '../ime/terminal-ime-composition-route'
import { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const IDLE = 'C:\\Windows\\System32\\cmd.exe'
let dispose: (() => void) | undefined

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function holdCmdBackspace() {
  const previousState = useAppStore.getState()
  const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: {
        onClearBufferRequest: () => () => {},
        onResetInputModesRequest: () => () => {},
        onSerializeBufferRequest: () => () => {}
      }
    }
  })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  useAppStore.setState({
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {}
  })
  const writes: string[] = []
  const transport = (id: string): PtyTransport => ({
    connect() {},
    attach() {},
    disconnect() {},
    resize: () => true,
    isConnected: () => true,
    getPtyId: () => id,
    getLocalSessionMetadata: () => ({ cwd: 'C:\\fixture', shellOverride: 'cmd.exe' }),
    sendInput: (data) => {
      writes.push(data)
      return true
    },
    sendInputImmediate: () => true
  })
  const original = transport('original-pty')
  const transports = new Map([
    [1, original],
    [2, transport('other-pty')]
  ])
  const titles = new Map<string, (title: string) => void>()
  const stops = ['original-pty', 'other-pty'].flatMap((id) => [
    registerPtySerializer(id, () => null),
    registerPtyTitleSource(id, (listener) => {
      titles.set(id, listener)
      return { dispose() {} }
    })
  ])
  for (const listener of titles.values()) {
    listener(IDLE)
  }
  const element = document.createElement('div')
  const pane = { id: 1, leafId: LEAF, terminal: { element } }
  const other = { id: 2, leafId: OTHER_LEAF, terminal: { element: document.createElement('div') } }
  let active = pane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this runtime path reads only mounted/active pane identities and the terminal element.
  const manager = {
    getPanes: () => [pane, other],
    getActivePane: () => active
  } as unknown as PaneManager
  const runtime = createTerminalKeyboardRuntime({
    tabId: 'ime-tab',
    worktreeId: 'fixture',
    isMac: false,
    isWindows: true,
    shortcutPlatform: 'win32',
    keyboardScopeRef: { current: element },
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    fallbackCwd: 'C:\\fixture',
    macOptionAsAltRef: { current: 'false' },
    terminalShortcutPolicy: 'orca-first'
  })
  const route = installTerminalImeCompositionRoute({
    terminalElement: element,
    terminal: {
      input: (data) => {
        original.sendInput(data, 'driving')
      }
    },
    capturedTransport: original,
    getCurrentTransport: () => transports.get(1)
  })
  element.dispatchEvent(
    new CustomEvent(XTERM_COMPOSITION_SESSION_START_EVENT, { detail: { id: 1 } })
  )
  const key = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', ctrlKey: true })
  const action = runtime.resolveShortcutEvent(key)
  if (action?.type !== 'sendInput') {
    throw new Error('Expected a resolved Ctrl+Backspace input')
  }
  runtime.deferredChordSender.defer(
    key,
    element,
    runtime.createCapturedInputSender(pane, action.data)
  )
  dispose = () => {
    runtime.deferredChordSender.cancelPending()
    route.dispose()
    for (const stop of stops.toReversed()) {
      stop()
    }
    useAppStore.setState(previousState, true)
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
  return {
    writes,
    title: (title: string) => titles.get('original-pty')?.(title),
    activateOther: () => {
      active = other
    },
    commit: () => {
      element.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT, {
          cancelable: true,
          detail: { id: 1, data: '字' }
        })
      )
      vi.advanceTimersByTime(0)
    }
  }
}

it('rechecks the captured original pane after an IME-held word erase and a title-only veto', () => {
  const held = holdCmdBackspace()
  held.title(`${IDLE} - python -i tools\\cmd.exe`)
  held.activateOther()
  held.commit()
  expect(held.writes).toEqual(['字', '\x17'])
})

it('rechecks a launch-only veto before delivering the IME-held word erase', () => {
  const held = holdCmdBackspace()
  useAppStore
    .getState()
    .registerAgentLaunchConfig(
      `ime-tab:${LEAF}`,
      { agentArgs: '', agentEnv: {} },
      { agentType: 'claude', tabId: 'ime-tab', leafId: LEAF }
    )
  held.commit()
  expect(held.writes).toEqual(['字', '\x17'])
})
