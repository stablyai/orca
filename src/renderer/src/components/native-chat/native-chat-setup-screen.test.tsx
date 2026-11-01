// @vitest-environment happy-dom
import { useNativeChatSetupHold } from './use-native-chat-setup-hold'
import { createRef } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatComposer } from './NativeChatComposer'
import type * as ComposerFieldModule from './NativeChatComposerField'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { NativeChatSetupNotice } from './NativeChatSetupNotice'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '../../runtime/structured-agent-session-status-feed'
const transport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: transport.subscribe
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))
import {
  readNativeChatAttachmentCache,
  writeNativeChatDraftCache,
  clearNativeChatDraftCacheForTests
} from './native-chat-draft-cache'
import { promptValue } from './native-chat-prompt-editor.test-support'
import { updateNativeChatComposerDraft } from './native-chat-composer-draft-store'

const attachmentRemoval = vi.hoisted(() => ({
  capture: vi.fn<(remove: (id: string) => void) => void>()
}))
vi.mock('./NativeChatComposerField', async (importOriginal) => {
  const actual = await importOriginal<typeof ComposerFieldModule>()
  return {
    ...actual,
    NativeChatComposerField: (props: Parameters<typeof actual.NativeChatComposerField>[0]) => {
      attachmentRemoval.capture(props.onRemoveImageAttachment)
      return <actual.NativeChatComposerField {...props} />
    }
  }
})

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-session-options', () => ({
  useNativeChatSessionOptions: () => ({ surface: null, snapshot: [] })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: vi.fn() }))

const WT = 'repo-setup::/workspace'
const TAB = 'setup-chat'
const PANE = `${TAB}::session`
const frames: ((event: AgentSessionStatusEvent) => void)[] = []
let deactivate = () => {}
const target = createRef<NativeChatComposerHandle>()
const stop = vi.fn()
const send = vi.fn(() => true)
const settings = vi.fn()
const open = vi.fn()
const search = vi.fn()
const oldApi = window.api

beforeEach(async () => {
  resetStructuredAgentSessionStatusFeedsForTests()
  frames.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: 'runtime:server',
    tabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          title: 'Claude',
          createdAt: 1,
          ptyId: null,
          worktreeId: WT,
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    setSettingsSearchQuery: search,
    openSettingsTarget: settings,
    openSettingsPage: open
  })
  const inert = () => () => {}
  window.api = new Proxy(oldApi ?? {}, { get: () => new Proxy({}, { get: () => inert }) })
  clearNativeChatDraftCacheForTests()
  writeNativeChatDraftCache(PANE, 'retained draft')
  vi.clearAllMocks()
  transport.subscribe.mockImplementation(
    (_target: RuntimeClientTarget, emit: (event: AgentSessionStatusEvent) => void) => {
      frames.push(emit)
      return Promise.resolve({ unsubscribe: () => {} })
    }
  )
  deactivate = getStructuredAgentSessionStatusFeed({
    kind: 'environment',
    environmentId: 'server'
  }).activate()
  await vi.waitFor(() => expect(frames).toHaveLength(1))
})
afterEach(() => {
  cleanup()
  deactivate()
  resetStructuredAgentSessionStatusFeedsForTests()
  window.api = oldApi
  clearNativeChatDraftCacheForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function project(held?: boolean) {
  act(() =>
    frames.at(-1)?.({
      type: 'snapshot',
      sessions: [],
      ...(held === undefined ? {} : { setupHeldWorkspaceIds: held ? [WT] : [] })
    })
  )
}
function Notice() {
  const { held, worktreeId, executionHostId } = useNativeChatSetupHold(TAB)
  return held ? (
    <NativeChatSetupNotice worktreeId={worktreeId} executionHostId={executionHostId} />
  ) : null
}
function chat(structured: boolean, working = false, canSend = true) {
  return (
    <TooltipProvider>
      <Notice />
      <NativeChatComposer
        ref={target}
        terminalTabId={TAB}
        paneKey={PANE}
        targetPtyId={structured ? null : 'pty-local'}
        agent="claude"
        canSend={canSend}
        isWorking={working}
        onStop={stop}
        structuredTransport={
          structured
            ? {
                capturePresentation: () => () => true,
                send,
                dispatchCommand: vi.fn(async () => ({
                  handled: false,
                  accepted: false,
                  error: null
                })),
                optionsSurface: {
                  getSnapshot: () => [],
                  setOption: vi.fn(),
                  invokeAction: vi.fn(),
                  subscribe: () => () => {}
                },
                optionSnapshot: [],
                onError: vi.fn(),
                runtime: 'remote',
                runtimeEnvironmentId: 'server',
                sessionId: 'session'
              }
            : undefined
        }
      />
    </TooltipProvider>
  )
}

it.each([true, false])(
  'locks the real %s composer without a lease notice, preserving draft and re-enabling on release',
  async (structured) => {
    project(true)
    render(chat(structured))
    const editor = screen.getByRole('textbox')
    expect(editor.getAttribute('contenteditable')).toBe('false')
    expect(promptValue(editor)).toBe('retained draft')
    expect(screen.getByText('Waiting for setup script to complete')).toBeTruthy()
    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(true)
    expect(target.current?.insertTypedText('no')).toBe(false)
    act(() => target.current?.appendText('no'))
    fireEvent.paste(editor, { clipboardData: { getData: () => 'no', items: [], files: [] } })
    expect(promptValue(editor)).toBe('retained draft')
    expect(screen.queryByText('Input is held by another device.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change in settings' }))
    expect(settings).toHaveBeenCalledWith({
      pane: 'repo',
      repoId: 'repo-setup',
      hostId: 'runtime:server',
      sectionId: 'repo-repo-setup-local-commands'
    })
    expect(search).toHaveBeenCalledWith('')
    expect(open).toHaveBeenCalledOnce()
    project(false)
    expect(screen.queryByText('Waiting for setup script to complete')).toBeNull()
    expect(screen.getByRole('textbox')).toBe(editor)
    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(promptValue(editor)).toBe('retained draft')
    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(false)
    project(true)
    act(() => frames.at(-1)?.({ type: 'end' }))
    expect(screen.queryByText('Waiting for setup script to complete')).toBeNull()
    expect(editor.getAttribute('contenteditable')).toBe('false')
    await act(async () => {
      await vi.waitFor(() => expect(frames).toHaveLength(2))
    })
    project(undefined)
    expect(editor.getAttribute('contenteditable')).toBe('true')
  }
)

it.each([true, false])(
  'keeps %s turnless Stop enabled with a retained draft while waiting',
  (structured) => {
    project(true)
    render(chat(structured, true))
    const button = screen.getByRole('button', { name: /stop/i })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByText('Waiting for setup script to complete')).toBeTruthy()
    expect(promptValue(screen.getByRole('textbox'))).toBe('retained draft')
  }
)

it('shows setup before a bridge has provider identity', () => {
  project(true)
  render(
    <NativeChatSessionGate
      paneKey="unresolved"
      launchAgent={null}
      resolvedAgent={null}
      ptyId={null}
      pending={<Notice />}
    >
      {() => null}
    </NativeChatSessionGate>
  )
  expect(screen.getByText('Waiting for setup script to complete')).toBeTruthy()
  expect(screen.queryByText('Not an agent terminal')).toBeNull()
})

it('fences a retired status source and reads a fresh old-host omission as not held', async () => {
  project(true)
  render(chat(true))
  const editor = screen.getByRole('textbox')
  const retired = frames[0]
  act(() => retired?.({ type: 'end' }))
  expect(editor.getAttribute('contenteditable')).toBe('false')
  await act(async () => {
    await vi.waitFor(() => expect(frames).toHaveLength(2))
  })
  expect(frames).toHaveLength(2)
  project(undefined)
  act(() => retired?.({ type: 'snapshot', sessions: [], setupHeldWorkspaceIds: [WT] }))
  expect(editor.getAttribute('contenteditable')).toBe('true')
  project(true)
  expect(editor.getAttribute('contenteditable')).toBe('false')
  expect(promptValue(editor)).toBe('retained draft')
})

it('observes direct SSH setup on its serving runtime while Settings keeps the execution host', async () => {
  useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:box' })
  render(chat(false))
  await act(async () => {
    await Promise.resolve()
  })
  expect(transport.subscribe).toHaveBeenLastCalledWith(
    { kind: 'local' },
    expect.any(Function),
    expect.any(Function),
    expect.any(Function)
  )
  project(true)
  expect(screen.getByText('Waiting for setup script to complete')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Change in settings' }))
  expect(settings).toHaveBeenCalledWith(
    expect.objectContaining({ repoId: 'repo-setup', hostId: 'ssh:box' })
  )
})

it('keeps a structured tab on its stamped host even when the active same-id workspace is local', () => {
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'local',
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          entityId: 'session',
          groupId: 'group',
          worktreeId: WT,
          executionHostId: 'runtime:server',
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
  project(true)
  render(chat(true))
  expect(screen.getByText('Waiting for setup script to complete')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Change in settings' }))
  expect(settings).toHaveBeenCalledWith(
    expect.objectContaining({ repoId: 'repo-setup', hostId: 'runtime:server' })
  )
})

it('disables actual editing before the first answer without inventing a notice, then accepts old-host absence', () => {
  render(chat(true))
  expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('false')
  expect(screen.queryByText('Waiting for setup script to complete')).toBeNull()
  project(undefined)
  expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('true')
})

it.each([true, false])(
  'retains settled and unavailable images while setup holds structured=%s, then permits removal',
  (structured) => {
    const images = [
      { id: 'image-v703', path: '/tmp/v703-diagram.png' },
      { id: 'unavailable-v706', path: '', unavailableName: 'missing-diagram.png' }
    ]
    updateNativeChatComposerDraft(PANE, { images }, 'immediate')
    project(false)
    const view = render(chat(structured))
    const editor = screen.getByRole('textbox')
    const buttons = screen.getAllByRole('button', { name: 'Remove attachment' })
    expect(buttons).toHaveLength(2)
    const retainedRemove = attachmentRemoval.capture.mock.calls.at(-1)?.[0]
    expect(retainedRemove).toBeTypeOf('function')
    project(true)
    expect(editor.getAttribute('contenteditable')).toBe('false')
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }
    act(() => {
      for (const image of images) {
        retainedRemove?.(image.id)
      }
    })
    expect(readNativeChatAttachmentCache(PANE)).toEqual(images)
    expect(promptValue(editor)).toBe('retained draft')
    project(false)
    expect(screen.getByRole('textbox')).toBe(editor)
    expect(editor.getAttribute('contenteditable')).toBe('true')
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(false)
    }
    view.rerender(chat(structured, false, false))
    expect(editor.getAttribute('contenteditable')).toBe('false')
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(false)
    }
    for (const [index, button] of buttons.entries()) {
      fireEvent.click(button)
      expect(readNativeChatAttachmentCache(PANE)).toEqual(images.slice(index + 1))
    }
    expect(promptValue(editor)).toBe('retained draft')
  }
)
