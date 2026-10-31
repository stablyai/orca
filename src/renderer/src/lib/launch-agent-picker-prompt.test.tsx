// @vitest-environment happy-dom
import {
  liveStore,
  mockCreateTab,
  mockPasteDraftWhenAgentReady,
  mockCreateSupport,
  mockCreateStructuredCodexSessionLaunchIntent,
  mockLaunchStructuredCodexSession,
  structuredLaunchIntent,
  launchErrorMocks
} from './launch-agent-structured-chat-test-fixture'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import { useTabAgentMenuLaunch } from '@/components/tab-bar/QuickLaunchButton'
import TabBarCreateEntry from '@/components/tab-bar/TabBarCreateEntry'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { agentLaunchPromptScopeKey } from '@/components/agent/AgentLaunchPromptComposer'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  changePrompt,
  promptEditor
} from '@/components/native-chat/native-chat-prompt-editor.test-support'
import type { AgentPickerEntry } from '../../../shared/agent-launch-picker'
import * as launcher from './launch-agent-in-new-tab'
import type * as StructuredLaunch from './launch-structured-agent-session'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'

let actualStructuredLaunch: typeof StructuredLaunch
beforeAll(async () => {
  actualStructuredLaunch = await vi.importActual<typeof StructuredLaunch>(
    './launch-structured-agent-session'
  )
})

const fileList = vi.hoisted(() => ({ files: [], loading: false, loadError: null }))
vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => fileList
}))

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  worktreeId: 'wt-1',
  rows: [{ agent: 'claude', kind: 'cli', executionHostId: 'local' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  arguments: '',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'launch-model', label: 'Launch model', efforts: [], isDefault: true }]
  }
}

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

function Menu({
  route,
  selected = entry
}: {
  route: 'menu' | 'search'
  selected?: AgentPickerEntry
}) {
  const launch = useTabAgentMenuLaunch({
    worktreeId: 'wt-1',
    groupId: 'group-1',
    onFocusTerminal: () => {}
  })
  return (
    <TooltipProvider>
      {route === 'search' ? (
        <TabBarCreateEntry
          worktreeId="wt-1"
          groupId="group-1"
          menuOpen
          agentPickerEntries={[selected]}
          onOpenEntry={async () => {}}
          onLaunchAgentOption={(option) =>
            option.row ? launch(option.row, option.setup, option.pickerEntry) : false
          }
        />
      ) : (
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={[selected]} runLaunch={launch} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </TooltipProvider>
  )
}

function editor(): HTMLElement {
  return document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
}
function button(name: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((button) => button.textContent === name)!
}

it.each(
  (['menu', 'search'] as const).flatMap((route) =>
    (['claude', 'codex'] as const).map((agent) => ({ route, agent }))
  )
)(
  'preserves refused $route $agent setup prompts and selected skill paths through the actual terminal launcher',
  async ({ route, agent }) => {
    const selected: AgentPickerEntry = {
      ...entry,
      agent,
      label: agent === 'claude' ? 'Claude' : 'Codex',
      rows: [{ agent, kind: 'cli', executionHostId: 'local' }]
    }
    const scope = agentLaunchPromptScopeKey(selected)
    const actualLaunch = launcher.launchAgentInNewTab
    const dispatch = vi
      .spyOn(launcher, 'launchAgentInNewTab')
      .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'win32' }))
    const view = render(<Menu route={route} selected={selected} />)
    if (route === 'search') {
      fireEvent.change(view.container.querySelector('input')!, {
        target: { value: 'launch-model' }
      })
    }
    fireEvent.click(document.querySelector(`button[aria-label="Configure ${selected.label}"]`)!)
    const argumentsInput = document.querySelector('textarea[aria-label="Arguments"]')!
    fireEvent.change(argumentsInput, { target: { value: '--model "unterminated' } })
    changePrompt(editor(), 'review this change')
    await act(async () => button('Launch terminal').click())
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.results[0]).toMatchObject({ type: 'return', value: null })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft(scope).text).toBe('review this change')
    expect(document.querySelector('textarea[aria-label="Arguments"]')).not.toBeNull()

    // The old Arguments Enter gesture reaches the same refusal without consuming its prompt.
    await act(async () => fireEvent.keyDown(argumentsInput, { key: 'Enter' }))
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.results[1]).toMatchObject({ type: 'return', value: null })
    expect(readNativeChatComposerDraft(scope).text).toBe('review this change')

    fireEvent.change(argumentsInput, { target: { value: '--add-dir docs' } })
    act(() =>
      promptEditor(editor()).commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'nativeChatSkill',
                attrs: {
                  token: agent === 'codex' ? '$review' : '/review',
                  path: '/repo/.claude/skills/review/SKILL.md'
                }
              },
              { type: 'text', text: ' and ' },
              {
                type: 'nativeChatSkill',
                attrs: {
                  token: agent === 'codex' ? '$review' : '/review',
                  path: '/home/me/.claude/skills/review/SKILL.md'
                }
              },
              { type: 'text', text: ' this change' }
            ]
          }
        ]
      })
    )
    await act(async () => button('Launch terminal').click())
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls.at(-1)?.[0].prompt).toContain('/repo/.claude/skills/review/SKILL.md')
    expect(dispatch.mock.calls.at(-1)?.[0].prompt).toContain(
      '/home/me/.claude/skills/review/SKILL.md'
    )
    const created = mockCreateTab.mock.calls[0]
    expect(JSON.stringify(created)).toContain('/repo/.claude/skills/review/SKILL.md')
    expect(JSON.stringify(created)).toContain('/home/me/.claude/skills/review/SKILL.md')
    await waitFor(() => expect(readNativeChatComposerDraft(scope).text).toBe(''))
    expect(liveStore().getState().activeWorktreeId).toBe('wt-1')
  }
)

it('keeps direct row launch empty even when that workspace has an unsent launch draft', () => {
  updateNativeChatComposerDraft(
    agentLaunchPromptScopeKey(entry),
    { text: 'saved for setup only', images: [] },
    'immediate'
  )
  const actualLaunch = launcher.launchAgentInNewTab
  const dispatch = vi
    .spyOn(launcher, 'launchAgentInNewTab')
    .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'win32' }))
  render(<Menu route="menu" />)
  fireEvent.click(document.querySelector('[role="menuitem"]')!)
  expect(mockCreateTab).toHaveBeenCalledOnce()
  expect(dispatch.mock.calls[0][0].prompt).toBeUndefined()
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toBe(
    'saved for setup only'
  )
})

it.each([true, false])(
  'preserves selected skill files in chat create and refusal hand-back, create-message=%s',
  async (createMessageSupport) => {
    mockCreateSupport.mockResolvedValue({ supported: true })
    mockCreateStructuredCodexSessionLaunchIntent.mockImplementation(
      (worktreeId, agent, host, resume, seed) => {
        const intent = actualStructuredLaunch.createStructuredAgentSessionLaunchIntent(
          worktreeId,
          agent,
          host,
          resume,
          seed,
          false
        )
        return {
          ...intent,
          sessionId: 'codex-session-1',
          params: { ...intent.params, envelope: structuredLaunchIntent(worktreeId).params.envelope }
        }
      }
    )
    let preparedFirstMessage: unknown
    const preparationErrors: string[] = []
    mockLaunchStructuredCodexSession.mockImplementation(async (intent) => {
      await Promise.resolve()
      intent.createMessageSupport = createMessageSupport
      try {
        intent.prepareCreate!(false)
      } catch (error) {
        preparationErrors.push(String(error))
        throw error
      }
      preparedFirstMessage = intent.params.firstMessage
      throw Object.assign(
        new launchErrorMocks.StructuredAgentSessionCreateRefusalError('provider unavailable'),
        { code: 'structured_agent_session_unsupported' }
      )
    })
    const selected: AgentPickerEntry = {
      ...entry,
      agent: 'codex',
      label: 'Codex',
      rows: [{ agent: 'codex', kind: 'cli', executionHostId: 'local' }]
    }
    const actualLaunch = launcher.launchAgentInNewTab
    const dispatch = vi
      .spyOn(launcher, 'launchAgentInNewTab')
      .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'linux' }))
    render(<Menu route="menu" selected={selected} />)
    fireEvent.click(document.querySelector('button[aria-label="Configure Codex"]')!)
    act(() =>
      promptEditor(editor()).commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'nativeChatSkill',
                attrs: { token: '$review', path: '/repo/.agents/skills/review/SKILL.md' }
              },
              { type: 'text', text: ' and ' },
              {
                type: 'nativeChatSkill',
                attrs: { token: '$review', path: '/home/me/.agents/skills/review/SKILL.md' }
              },
              { type: 'text', text: ' this change' }
            ]
          }
        ]
      })
    )
    await act(async () => button('Launch chat').click())
    const call = dispatch.mock.results[0]
    const result = call?.type === 'return' ? call.value : null
    expect(result?.surface.kind).toBe('host-published')
    expect(await result?.structuredSettlement).toMatchObject({ kind: 'failed' })
    expect(preparationErrors).toEqual([])
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledOnce()
    if (createMessageSupport) {
      expect(JSON.stringify(preparedFirstMessage)).toContain('/repo/.agents/skills/review/SKILL.md')
      expect(JSON.stringify(preparedFirstMessage)).toContain(
        '/home/me/.agents/skills/review/SKILL.md'
      )
    } else {
      expect(preparedFirstMessage).toBeUndefined()
    }
    await expect(result?.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true
    })
    const returned = readNativeChatComposerDraft(
      structuredAgentSessionDraftScopeKey('codex-session-1')
    ).text
    expect(returned).toContain('/repo/.agents/skills/review/SKILL.md')
    expect(returned).toContain('/home/me/.agents/skills/review/SKILL.md')
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(selected)).text).toBe('')
  }
)

it('holds an actual clipboard-image paste until its save settles before launching', async () => {
  const actualLaunch = launcher.launchAgentInNewTab
  const dispatch = vi
    .spyOn(launcher, 'launchAgentInNewTab')
    .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'linux' }))
  render(<Menu route="menu" />)
  fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
  let finishSave: (path: string) => void = () => {}
  const save = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finishSave = resolve
      })
  )
  const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, ui: { ...window.api?.ui, saveClipboardImageAsTempFile: save } }
  })
  try {
    const data = new DataTransfer()
    data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
    fireEvent(
      editor(),
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await act(async () => button('Launch terminal').click())
    expect(dispatch).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
    await act(async () => finishSave('/tmp/launch-image.png'))
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toContain(
        '/tmp/launch-image.png'
      )
    )
    await act(async () => button('Launch terminal').click())
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0][0].prompt).toContain('/tmp/launch-image.png')
  } finally {
    cleanup()
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
})

import * as hostPreferences from '@/components/settings/use-host-agent-launch-preferences'
import * as launchSettings from '@/components/settings/agent-launch-settings-transport'
import * as webEnvironment from '@/runtime/web-runtime-session-environment'
import * as worktreeHost from '@/lib/worktree-runtime-owner'
import * as terminalCreate from '@/runtime/web-runtime-terminal-create-operation'
import * as runtimeRpc from '@/runtime/runtime-rpc-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

it.each([
  { route: 'menu' as const, agent: 'claude' as const, failure: 'preferences' },
  { route: 'search' as const, agent: 'codex' as const, failure: 'create' },
  { route: 'search' as const, agent: 'claude' as const, failure: 'unknown' },
  { route: 'menu' as const, agent: 'codex' as const, failure: 'paste' }
])(
  'recovers deferred $failure through $route $agent setup then explicitly retries once',
  async ({ route, agent, failure }) => {
    const selected: AgentPickerEntry = {
      ...entry,
      agent,
      label: agent === 'claude' ? 'Claude' : 'Codex',
      rows: [{ agent, kind: 'cli', executionHostId: 'runtime:paired' }]
    }
    const scope = agentLaunchPromptScopeKey(selected)
    vi.spyOn(webEnvironment, 'isWebRuntimeSessionActive').mockReturnValue(true)
    vi.spyOn(worktreeHost, 'runtimeEnvironmentIdOrLocalUnlessTwin').mockReturnValue('paired')
    vi.spyOn(launchSettings, 'hostSupportsLaunchChoices').mockResolvedValue(true)
    const actualLaunch = launcher.launchAgentInNewTab
    const dispatch = vi.spyOn(launcher, 'launchAgentInNewTab').mockImplementation((args) =>
      actualLaunch({
        ...args,
        ...(failure === 'paste' ? { promptDelivery: 'submit-after-ready' } : {})
      })
    )
    const preferences = Promise.withResolvers<hostPreferences.AgentLaunchPreferences>()
    vi.spyOn(hostPreferences, 'ensureAgentLaunchPreferences').mockImplementation(
      () => preferences.promise
    )
    const created =
      Promise.withResolvers<
        Awaited<ReturnType<typeof terminalCreate.createWebRuntimeSessionTerminalResult>>
      >()
    const actualCreate = terminalCreate.createWebRuntimeSessionTerminalResult
    const create = vi
      .spyOn(terminalCreate, 'createWebRuntimeSessionTerminalResult')
      .mockImplementation(() => created.promise)
    const response = Promise.withResolvers<RuntimeRpcResponse<unknown>>()
    const call = vi.fn<ReturnType<typeof webEnvironment.captureRuntimeEnvironmentCall>>(
      () => response.promise
    )
    vi.spyOn(webEnvironment, 'captureRuntimeEnvironmentCall').mockReturnValue(call)
    vi.spyOn(runtimeRpc, 'runtimeEnvironmentSupportsCapability').mockResolvedValue(true)
    if (failure === 'create' || failure === 'unknown') {
      create.mockImplementationOnce(actualCreate)
    }
    liveStore().setState({ setActiveWorktree: vi.fn() })
    const view = render(<Menu route={route} selected={selected} />)
    if (route === 'search') {
      fireEvent.change(view.container.querySelector('input')!, {
        target: { value: 'launch-model' }
      })
    }
    fireEvent.click(document.querySelector(`button[aria-label="Configure ${selected.label}"]`)!)
    changePrompt(editor(), 'review @/repo/file')
    await act(async () => button('Launch terminal').click())
    expect(readNativeChatComposerDraft(scope).text).toBe('')
    view.unmount()
    if (failure === 'preferences') {
      await act(async () => preferences.reject(new DOMException('Pairing changed', 'AbortError')))
      expect(create).not.toHaveBeenCalled()
    } else {
      await act(async () =>
        preferences.resolve({ defaultTuiAgent: undefined, disabledTuiAgents: undefined })
      )
      await waitFor(() => expect(create).toHaveBeenCalledOnce())
      if (failure === 'paste') {
        mockPasteDraftWhenAgentReady.mockRejectedValueOnce(new Error('paste failed'))
        await act(async () =>
          created.resolve({ outcome: { status: 'created' }, hostTabId: 'paste-target' })
        )
      } else {
        await waitFor(() => expect(call).toHaveBeenCalledOnce())
        await act(async () => {
          if (failure === 'unknown') {
            response.reject(new Error('Response lost after remote applied'))
          } else {
            response.resolve({
              id: 'refused',
              ok: false,
              error: { code: 'forbidden', message: 'Host refused before create' }
            })
          }
        })
        await waitFor(() =>
          expect(readNativeChatComposerDraft(scope).text).toBe('review @/repo/file')
        )
        expect(call).toHaveBeenCalledTimes(failure === 'unknown' ? 2 : 1)
        if (failure === 'unknown') {
          expect(call.mock.calls[0][0]).toEqual(call.mock.calls[1][0])
        }
      }
    }
    await waitFor(() => expect(readNativeChatComposerDraft(scope).text).toBe('review @/repo/file'))
    vi.mocked(hostPreferences.ensureAgentLaunchPreferences).mockResolvedValue({
      defaultTuiAgent: undefined,
      disabledTuiAgents: undefined
    })
    create.mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'accepted' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    const retry = render(<Menu route={route} selected={selected} />)
    if (route === 'search') {
      fireEvent.change(retry.container.querySelector('input')!, {
        target: { value: 'launch-model' }
      })
    }
    fireEvent.click(document.querySelector(`button[aria-label="Configure ${selected.label}"]`)!)
    expect(editor().textContent).toContain('review @/repo/file')
    await act(async () => button('Launch terminal').click())
    await expect(dispatch.mock.results.at(-1)?.value?.promptDeliveryResult).resolves.toMatchObject({
      delivered: true
    })
    await waitFor(() => expect(readNativeChatComposerDraft(scope).text).toBe(''))
    expect(create).toHaveBeenCalledTimes(failure === 'preferences' ? 1 : 2)
  }
)

it('returns setup input when explicit chat is refused before session admission', async () => {
  mockCreateSupport.mockResolvedValue({ supported: false, reason: 'Not available here' })
  render(<Menu route="search" />)
  fireEvent.change(document.querySelector('input')!, { target: { value: 'launch-model' } })
  fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
  changePrompt(editor(), 'task before any session')
  await act(async () => button('Launch chat').click())
  await waitFor(() =>
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toBe(
      'task before any session'
    )
  )
  expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()
})

it.each(['auto-submit', 'draft'] as const)(
  'honors local no-future %s ownership instead of treating it as a missing result',
  async (promptDelivery) => {
    const actual = launcher.launchAgentInNewTab
    const dispatch = vi
      .spyOn(launcher, 'launchAgentInNewTab')
      .mockImplementation((args) => actual({ ...args, promptDelivery }))
    render(<Menu route="menu" />)
    fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
    changePrompt(editor(), 'local prompt')
    await act(async () => button('Launch terminal').click())
    expect(dispatch.mock.results[0].value?.promptDeliveryResult).toBeUndefined()
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toBe('')
  }
)
