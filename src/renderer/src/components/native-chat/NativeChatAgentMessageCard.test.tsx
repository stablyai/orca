// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveStructuredAgentSessionOwner } from '@/runtime/structured-agent-session-owner'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/runtime-host-status'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as cache from '@/components/dashboard/worktree-agent-rows-cache'
import * as selectors from '@/components/sidebar/worktree-agent-row-selectors'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { useAgentMessageSenderSource } from './native-chat-agent-message-sender-source'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../shared/agent-session-write-notice-copy'
import * as markdown from './NativeChatMarkdown'
import * as display from '../../../../shared/agent-session/agent-message-display-text'
import type * as SonnerModule from 'sonner'
import type * as RuntimeRpc from '@/runtime/runtime-rpc-client'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'

const navigation = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpc>()),
  callRuntimeRpc: navigation.rpc
}))
vi.mock('sonner', async (importOriginal) => {
  const original = await importOriginal<typeof SonnerModule>()
  return {
    ...original,
    toast: Object.assign(
      function (this: unknown, ...args: Parameters<typeof original.toast>) {
        return original.toast.apply(this, args)
      },
      original.toast,
      { error: navigation.toast }
    )
  }
})
const initialStore = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'
const renders = new Map<number, number>()
const views = new Map<number, AgentMessageSenderView>()
function status(i: number, worktreeId = 'workspace'): AgentStatusEntry {
  return {
    paneKey: `tab-${i}:${LEAF}`,
    worktreeId,
    terminalHandle: `term_${i}`,
    agentType: 'claude',
    state: 'working',
    prompt: 'work',
    updatedAt: 2_000_000,
    stateStartedAt: 2_000_000,
    stateHistory: []
  }
}
function Probe({
  id,
  workspace = 'workspace',
  remote = false
}: {
  id: number
  workspace?: string
  remote?: boolean
}) {
  const value = useAgentMessageSenderView(
    {
      party: { address: `term_${id}`, terminalHandle: `term_${id}`, orcaSessionId: null },
      name: 'Sender'
    },
    workspace,
    remote ? { kind: 'environment', environmentId: 'remote' } : { kind: 'local' }
  )
  views.set(id, value)
  renders.set(id, (renders.get(id) ?? 0) + 1)
  return null
}
function write(i: number, update: Partial<AgentStatusEntry>) {
  const state = useAppStore.getState()
  const key = status(i).paneKey
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [key]: { ...state.agentStatusByPaneKey[key], ...update }
      },
      agentStatusEpoch: state.agentStatusEpoch + 1
    })
  )
}

let height = 48
let resize: () => void
let disconnects = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  renders.clear()
  views.clear()
  useAppStore.setState(
    {
      ...initialStore,
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: { workspace: [makeTab({ id: 'tab-0', worktreeId: 'workspace' })] },
      unifiedTabsByWorktree: {},
      agentStatusByPaneKey: { [status(0).paneKey]: status(0) },
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      paneForegroundAgentByPaneKey: {},
      agentStatusEpoch: 1
    },
    true
  )
  navigation.rpc.mockReset()
  navigation.toast.mockReset()
  height = 48
  disconnects = 0
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
    return height
  })
  const computedStyle = getComputedStyle
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = computedStyle(element)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'lineHeight') {
          return '24px'
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the style facade delegates native properties to the real style receiver, including binding its methods below.
        const value = target[key as keyof CSSStyleDeclaration]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {
        disconnects++
      }
    }
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: ['Build cards', 'Other sender'].map((name, i) => ({
    name,
    party: { address: `term_${i}`, terminalHandle: `term_${i}`, orcaSessionId: null }
  }))
}
const context = { worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' as const } }
function card(message: NativeChatMessage) {
  return (
    <NativeChatAgentMessageCard
      message={message}
      from={message.from!}
      runtimeContext={context}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
}
function slots(message: NativeChatMessage) {
  return buildNativeChatTranscriptSlots({
    messages: [message],
    turnKeys: [undefined],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
}

it.each(['task', 'mail'] as const)(
  'keeps native %s progress independent from Markdown and reparses own edits',
  async (kind) => {
    const paneKey = status(0).paneKey
    const entry = {
      ...status(0),
      programStatus: { state: 'working' as const, progress: 40, observedAt: 2_000_000 }
    }
    useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: entry } })
    const prefix =
      kind === 'task' ? 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n' : ''
    const message: NativeChatMessage = {
      id: `progress-${kind}`,
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      from: {
        ...from,
        orchestration:
          kind === 'task'
            ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
            : { message: 'mail-notice', mailbox: 'term_0', dispatchId: null, messages: [] }
      },
      blocks: [
        {
          type: 'text',
          text: `${prefix}Current **task** with [link](https://example.com) and ![image](https://example.com/image.png).\n\nSecond paragraph with [another link](https://example.com/second).`
        }
      ]
    }
    const convert = vi.spyOn(display, 'agentMessageTranscriptText')
    const renderMarkdown = vi.spyOn(markdown, 'NativeChatMarkdown')
    let mounted = render(card(message))
    expect(
      screen.getByText(kind === 'task' ? 'Task from your coordinator' : 'Message from')
    ).toBeInTheDocument()
    expect(screen.getByText('task', { selector: 'strong' })).toBeInTheDocument()
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    expect(mounted.container.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
    expect(screen.getByRole('img', { name: 'image' })).toHaveAttribute(
      'src',
      'https://example.com/image.png'
    )
    const text =
      'Current **task** with [link](https://example.com) and ![image](https://example.com/image.png).\n\nSecond paragraph with [another link](https://example.com/second).'
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    navigation.rpc.mockRejectedValue(new Error('unreachable'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build cards' })))
    expect(navigation.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.partyLocation', {
      address: 'term_0'
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other sender' })))
    expect(navigation.rpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'orchestration.partyLocation',
      { address: 'term_1' }
    )
    expect(navigation.toast).toHaveBeenCalledWith(
      `${AGENT_SESSION_WRITE_NOTICE_COPY.unreachable} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    act(() => {
      height = 120
      resize()
    })
    const more = screen.getByRole('button', { name: 'Show more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const clip = document.getElementById(more.getAttribute('aria-controls')!)!
    const first = screen.getByRole('link', { name: 'link' })
    const second = screen.getByRole('link', { name: 'another link' })
    const documentFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    first.focus()
    clip.scrollTop = 74
    second.focus()
    expect(second).toHaveFocus()
    expect(clip.scrollTop).toBe(74)
    documentFocus.mockReturnValue(false)
    second.blur()
    expect(clip.scrollTop).toBe(74)
    documentFocus.mockReturnValue(true)
    second.focus()
    more.focus()
    expect(more).toHaveFocus()
    expect(clip.scrollTop).toBe(0)
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
    expect(writeClipboardText).toHaveBeenCalledWith(text)
    expect(nativeChatSlotCopyText(slots(message), message.id)).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    act(() => {
      height = 48
      resize()
    })
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    for (const remount of [false, true]) {
      if (remount) {
        mounted.unmount()
        mounted = render(card(message))
      }
      const ring = screen.getByRole('progressbar', { name: 'Working · 40%' })
      expect(ring).toHaveAttribute('aria-valuenow', '40')
      expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
        'stroke-dasharray',
        '40 100'
      )
    }
    for (const spy of [convert, renderMarkdown]) {
      spy.mockClear()
    }
    for (const progress of [60, null, 60, 0, 100]) {
      act(() =>
        useAppStore
          .getState()
          .setAgentProgramStatus(
            paneKey,
            progress === null ? null : { state: 'working', progress, observedAt: 2_000_000 }
          )
      )
      if (progress === null) {
        expect(screen.queryByRole('progressbar')).toBeNull()
        expect(screen.getByLabelText('Working')).toBeInTheDocument()
      } else {
        const ring = screen.getByRole('progressbar', { name: `Working · ${progress}%` })
        expect(ring).toHaveAttribute('aria-valuenow', String(progress))
        expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
          'stroke-dasharray',
          `${progress} 100`
        )
        expect(screen.queryByLabelText('Done')).toBeNull()
      }
      for (const spy of [convert, renderMarkdown]) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: { [paneKey]: { ...entry, state: 'done' } },
        agentStatusEpoch: 2
      })
    )
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    for (const spy of [convert, renderMarkdown]) {
      expect(spy).not.toHaveBeenCalled()
    }
    const edited = { ...message, blocks: [{ type: 'text' as const, text: `${prefix}Edited task` }] }
    mounted.rerender(card(edited))
    expect(screen.getByText('Edited task')).toBeInTheDocument()
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    await act(async () => fireEvent.click(copyButton))
    expect(copyButton).toHaveAccessibleName('Copied')
    expect(writeClipboardText).toHaveBeenCalledWith('Edited task')
    expect(nativeChatSlotCopyText(slots(edited), edited.id)).toBe('Edited task')
    const multiple: NativeChatMessage = {
      ...edited,
      blocks: [...edited.blocks, { type: 'text', text: 'Another paragraph' }]
    }
    mounted.rerender(card(multiple))
    await act(async () => fireEvent.click(copyButton))
    expect(writeClipboardText).toHaveBeenCalledWith(`${prefix}Edited task\n\nAnother paragraph`)
    expect(nativeChatSlotCopyText(slots(multiple), multiple.id)).toBe(
      `${prefix}Edited task\n\nAnother paragraph`
    )
    mounted.unmount()
    expect(disconnects).toBeGreaterThan(0)
  }
)

it.each([100, 1000])(
  'shares actual row acquisition and isolates selected progress across %i cards',
  (n) => {
    let visits = 0
    const live = new Proxy(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => {
          const entry = status(i)
          return [entry.paneKey, entry]
        })
      ),
      {
        ownKeys(target) {
          const keys = Object.getOwnPropertyNames(target)
          visits += keys.length
          return keys
        }
      }
    )
    useAppStore.setState({
      agentStatusByPaneKey: live,
      tabsByWorktree: {
        workspace: Array.from({ length: n }, (_, i) =>
          makeTab({ id: `tab-${i}`, worktreeId: 'workspace' })
        )
      },
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: n }, (_, i): [string, TerminalLayoutSnapshot] => [
          `tab-${i}`,
          { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
        ])
      )
    })
    const normalize = vi.spyOn(presentation, 'resolveRowProgramStatus')
    const mounted = render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <Probe key={id} id={id} />
        ))}
      </>
    )
    // Handle lookup, visible-authority acquisition and sidebar indexing each enumerate the N live entries.
    expect(visits).toBe(n * 3)
    expect(normalize).toHaveBeenCalledTimes(n)
    for (let i = 0; i < n; i++) {
      expect(views.get(i)?.dot).toBe('working')
    }
    const before = new Map(renders)
    visits = 0
    normalize.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    expect(renders).toEqual(before)
    for (const progress of [40, 60]) {
      normalize.mockClear()
      const epoch = useAppStore.getState().agentStatusEpoch
      act(() =>
        useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
          state: 'working',
          progress,
          observedAt: 2_000_000
        })
      )
      expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
      expect(normalize).toHaveBeenCalledTimes(n)
      expect(views.get(0)?.progress).toBe(progress)
      expect(renders.get(0)).toBe(before.get(0)! + (progress === 40 ? 1 : 2))
      for (let i = 1; i < n; i++) {
        expect(renders.get(i)).toBe(before.get(i))
      }
    }
    mounted.unmount()
  }
)

it('keeps other hosts isolated, retains completed senders, and releases disconnected subscriptions', () => {
  const create = vi.spyOn(cache, 'createWorktreeAgentRowsCache')
  const baseline = readStoreListenerCount()
  expect(baseline).not.toBeNull()
  const other = status(9, 'remote')
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: 'remote', repoId: TEST_REPO.id, hostId: 'runtime:remote' })
      ]
    },
    tabsByWorktree: {
      ...useAppStore.getState().tabsByWorktree,
      remote: [makeTab({ id: 'tab-9', worktreeId: 'remote' })]
    },
    agentStatusByPaneKey: { ...useAppStore.getState().agentStatusByPaneKey, [other.paneKey]: other }
  })
  const mounted = render(
    <>
      <Probe id={0} />
      <Probe id={9} workspace="remote" remote />
    </>
  )
  expect(readStoreListenerCount()).toBeGreaterThan(baseline!)
  const leased = create.mock.results.flatMap((result) =>
    result.type === 'return' && result.value.byWorktree.size ? [result.value] : []
  )
  expect(leased.flatMap((value) => [...value.byWorktree.keys()]).sort()).toEqual([
    'remote',
    'workspace'
  ])
  const before = new Map(renders)
  write(9, { state: 'waiting' })
  expect(views.get(9)?.dot).toBe('waiting')
  expect(renders.get(9)).toBe(before.get(9)! + 1)
  expect(renders.get(0)).toBe(before.get(0))
  write(0, {
    agentType: 'codex',
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 }
  })
  expect(views.get(0)).toEqual({ agentType: 'codex', dot: 'permission', progress: 60 })
  expect(renders.get(9)).toBe(before.get(9)! + 1)
  for (const value of leased) {
    expect(value.lastComputedWorktreeIds.length).toBeLessThanOrEqual(1)
  }
  const entry = { ...status(0), state: 'done' as const }
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: { [other.paneKey]: other },
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          tab: makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
          worktreeId: 'workspace',
          agentType: 'claude',
          startedAt: 1
        }
      },
      runtimeStatusByEnvironmentId: new Map([
        [
          'remote',
          runtimeEnvironmentStatusFromSnapshot({
            environmentId: 'remote',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            verification: 'blocked',
            transport: 'disconnected',
            retired: true,
            status: null
          })
        ]
      ])
    })
  )
  expect(views.get(0)?.dot).toBe('done')
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' }))
  expect(views.get(0)).toEqual({})
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(views.get(0)?.dot).toBe('done')
  const disconnected = new Map(renders)
  const constructions = create.mock.calls.length
  act(() => useAppStore.setState({ sidebarBody: 'agents' }))
  expect(renders).toEqual(disconnected)
  expect(create).toHaveBeenCalledTimes(constructions)
  mounted.unmount()
  for (const value of leased) {
    expect(value.byWorktree.size).toBe(0)
  }
  expect(readStoreListenerCount()).toBe(baseline)
  render(<Probe id={0} />)
  expect(views.get(0)?.dot).toBe('done')
})

it('uses the child row own glyph even when its parent program needs permission', () => {
  write(0, {
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 },
    subagents: [{ id: 'child', state: 'working', startedAt: 2_000_000, description: 'Child' }]
  })
  const state = useAppStore.getState()
  const projected = cache.selectWorktreeAgentRowsCached({
    state,
    worktreeId: 'workspace',
    now: 2_000_000,
    generation: '',
    orchestration: selectors.selectRuntimeAgentOrchestrationForWorktree(state, 'workspace')
  })
  const child = projected.find((row) => row.childRow)!
  expect(child).toBeDefined()
  const locate = () => ({ host: 'local', worktreeId: 'workspace', paneKey: child.paneKey })
  let value: AgentMessageSenderView | undefined
  function Child() {
    value = useAgentMessageSenderSource(locate)
    return value.dot ? (
      <AgentStateDot state={value.dot} progress={value.progress} size="md" title={null} />
    ) : null
  }
  render(<Child />)
  expect(value?.dot).toBe('working')
  expect(value?.progress).toBeUndefined()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByLabelText('Working')).toBeDefined()
})

it('refuses a target-less ambiguous workspace twin while an explicit local target resolves', () => {
  const workspace = `${TEST_REPO.id}::/w`
  const entry = status(0, workspace)
  useAppStore.setState({
    repos: [TEST_REPO],
    activeWorktreeId: 'different',
    activeWorkspaceExecutionHostId: 'local',
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'local' }),
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'runtime:e' })
      ]
    },
    tabsByWorktree: { [workspace]: [makeTab({ id: 'tab-0', worktreeId: workspace })] },
    agentStatusByPaneKey: { [entry.paneKey]: entry }
  })
  const state = useAppStore.getState()
  expect(getKnownExecutionHostIdForWorktree(state, workspace)).toBe('local')
  expect(resolveStructuredAgentSessionOwner(state, workspace)).toBeNull()
  const view = renderHook(() => useAgentMessageSenderView(from.senders[0], workspace))
  expect(view.result.current).toEqual({})
  view.unmount()
  const explicit = renderHook(() =>
    useAgentMessageSenderView(from.senders[0], workspace, { kind: 'local' })
  )
  expect(explicit.result.current.dot).toBe('working')
})
