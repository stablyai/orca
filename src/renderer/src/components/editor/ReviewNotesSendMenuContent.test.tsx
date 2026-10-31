import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
import {
  TAB_A,
  TAB_B,
  LEAF_A,
  LEAF_B,
  hookRuntime,
  harness,
  agentRow,
  tab,
  leafLayout,
  setStore,
  findAllByType,
  findByType,
  collectText,
  render,
  flushMicrotasks
} from './ReviewNotesSendMenuContent.test-fixture'

describe('ReviewNotesSendMenuContent', () => {
  beforeEach(() => {
    hookRuntime.states = []
    hookRuntime.index = 0
    hookRuntime.cleanups = []
    harness.sendMessageToAgent.mockReset()
    harness.sendMessageToAgent.mockResolvedValue({ status: 'sent' })
    harness.track.mockReset()
    harness.toastMessage.mockReset()
    harness.worktreeAgentRows = []
    harness.noteTargets = []
    harness.now = 600_000
    setStore()
  })

  it('enumerates each running agent of the worktree as a send target', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: {
        'wt-1': [
          tab(TAB_A, { title: 'Terminal 1' }),
          tab(TAB_B, { title: 'Codex', launchAgent: 'codex' })
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      },
      {
        paneKey: makePaneKey(TAB_B, LEAF_B),
        tabId: TAB_B,
        messageTarget: { kind: 'terminal', tabId: TAB_B, leafId: LEAF_B },
        agentType: 'codex',
        tabTitle: 'Codex',
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.props.disabled === false)).toBe(true)
    expect(collectText(items[0])).toContain('Claude')
    expect(collectText(items[1])).toContain('Codex')
  })

  it('orders send targets by the current worktree agent rows and shows status timing', () => {
    const paneKeyA = makePaneKey(TAB_A, LEAF_A)
    const paneKeyB = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: paneKeyB,
        tabId: TAB_B,
        title: 'Second session',
        agentType: 'codex',
        startedAt: harness.now - 120_000
      }),
      agentRow({
        paneKey: paneKeyA,
        tabId: TAB_A,
        title: 'First session',
        agentType: 'claude',
        startedAt: harness.now - 60_000
      })
    ]
    setStore({
      tabsByWorktree: {
        'wt-1': [tab(TAB_A, { title: 'First session' }), tab(TAB_B, { title: 'Second session' })]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: paneKeyA,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'First session',
        status: 'eligible'
      },
      {
        paneKey: paneKeyB,
        tabId: TAB_B,
        messageTarget: { kind: 'terminal', tabId: TAB_B, leafId: LEAF_B },
        agentType: 'codex',
        tabTitle: 'Second session',
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(collectText(items[0])).toContain('Codex')
    expect(collectText(items[0])).toContain('Done')
    expect(collectText(items[0])).toContain('2m ago')
    expect(collectText(items[0])).toContain('Second session')
    expect(collectText(items[1])).toContain('Claude')
  })

  it('leads each row with the name its sidebar row shows, so same-type agents differ', () => {
    const paneKeyA = makePaneKey(TAB_A, LEAF_A)
    const paneKeyB = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({ paneKey: paneKeyA, tabId: TAB_A, title: 'Claude Code' }),
      agentRow({ paneKey: paneKeyB, tabId: TAB_B, title: 'Claude Code', prompt: 'Fix the login' })
    ]
    setStore({
      tabsByWorktree: {
        'wt-1': [
          tab(TAB_A, { title: 'Claude Code', customTitle: 'Payments' }),
          tab(TAB_B, { title: 'Claude Code' })
        ]
      }
    })
    harness.noteTargets = [
      [paneKeyA, TAB_A, LEAF_A],
      [paneKeyB, TAB_B, LEAF_B]
    ].map(([paneKey, tabId, leafId]): NotesSendAgentTarget => ({
      paneKey,
      tabId,
      messageTarget: { kind: 'terminal', tabId, leafId },
      agentType: 'claude',
      tabTitle: 'Claude Code',
      status: 'eligible'
    }))

    const rowLines = findAllByType(render(), 'DropdownMenuItem').map((item) =>
      findAllByType(item, 'span')
        .filter((span) => String(span.props.className).includes('truncate'))
        .map(collectText)
    )

    expect(rowLines).toEqual([
      ['Payments', 'Claude · Done · just now'],
      ['Fix the login', 'Claude · Done · just now']
    ])
  })

  it('shows a chat whose turn failed as failed, as its sidebar row does', () => {
    const chatPaneKey = 'structured-agent-session-claude_1:chat'
    const failedRow = agentRow({
      paneKey: chatPaneKey,
      tabId: 'structured-agent-session-claude_1',
      title: 'Claude Chat',
      agentType: 'claude'
    })
    failedRow.entry.mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: harness.now }
    harness.worktreeAgentRows = [failedRow]
    harness.noteTargets = [
      {
        paneKey: chatPaneKey,
        tabId: 'structured-agent-session-claude_1',
        messageTarget: { kind: 'structured-session', sessionId: 'claude_1' },
        agentType: 'claude',
        tabTitle: 'Claude Chat',
        status: 'eligible'
      }
    ]

    const item = findByType(render(), 'DropdownMenuItem')

    expect(findByType(item, 'AgentStateDot').props.state).toBe('failed')
    expect(collectText(item)).toContain('Failed')
    expect(collectText(item)).not.toContain('Done')
  })

  it('shows a stopped terminal agent as interrupted, as its sidebar row does', () => {
    const paneKey = makePaneKey(TAB_A, LEAF_A)
    const stoppedRow = agentRow({ paneKey, tabId: TAB_A, title: 'Terminal 1', agentType: 'claude' })
    stoppedRow.entry.interrupted = true
    harness.worktreeAgentRows = [stoppedRow]
    harness.noteTargets = [
      {
        paneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const item = findByType(render(), 'DropdownMenuItem')

    expect(findByType(item, 'AgentStateDot').props.state).toBe('interrupted')
    expect(collectText(item)).toContain('Interrupted')
  })

  it('does not target title-detected rows skipped by target derivation', async () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'idle',
        startedAt: harness.now
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: ['pty-b'] }
    })

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(harness.sendMessageToAgent).not.toHaveBeenCalled()
  })

  it('disables title-detected dashboard rows when target derivation reports permission', () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'blocked',
        startedAt: harness.now
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: ['pty-b'] }
    })
    harness.noteTargets = [
      {
        paneKey,
        tabId: TAB_B,
        messageTarget: { kind: 'terminal', tabId: TAB_B, leafId: LEAF_B },
        agentType: 'codex',
        tabTitle: 'Codex',
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      }
    ]

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')
    const stateDot = findByType(item, 'AgentStateDot')

    expect(item.props.disabled).toBe(true)
    expect(item.props.title).toBe('Agent needs permission')
    expect(stateDot.props.title).toBeNull()
    ;(item.props.onSelect as () => void)()
    expect(harness.sendMessageToAgent).not.toHaveBeenCalled()
  })

  it('sends notes to the chosen agent and tracks the send once it succeeds', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    const onPromptHandedOff = vi.fn()
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered, onPromptHandedOff })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(harness.sendMessageToAgent).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      target: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A }
    })
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(harness.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'claude-code',
      launch_source: 'notes_send',
      request_kind: 'followup'
    })
    expect(onPromptHandedOff).toHaveBeenCalledOnce()
    await onPromptHandedOff.mock.calls[0][0]
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
  })

  it('keeps selected-target note failures undelivered and uses selected wording', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    harness.sendMessageToAgent.mockResolvedValue({ status: 'not-ready' })
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(harness.track).not.toHaveBeenCalled()
    // Failure must settle the loading toast without leaving its spinner.
    const settled = toast
      .getToasts()
      .find((entry) => 'title' in entry && entry.title === 'selected:not-ready')
    expect(settled && 'type' in settled ? settled.type : undefined).toBe('info')
  })

  it.each(['terminal', 'structured-session'] as const)(
    'settles unknown %s notes without clearing them or claiming delivery',
    async (kind) => {
      harness.sendMessageToAgent.mockResolvedValue({ status: 'unconfirmed' })
      const onPromptDelivered = vi.fn()
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0)
        return 0
      })
      const dismiss = vi.spyOn(toast, 'dismiss')
      setStore({
        tabsByWorktree: { 'wt-1': [tab(TAB_A)] },
        terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
      })
      harness.noteTargets = [
        {
          paneKey: makePaneKey(TAB_A, LEAF_A),
          tabId: TAB_A,
          messageTarget:
            kind === 'terminal'
              ? { kind, tabId: TAB_A, leafId: LEAF_A }
              : { kind, sessionId: 'chat' },
          agentType: 'codex',
          tabTitle: 'Agent',
          status: 'eligible'
        }
      ]
      const before = new Set(toast.getHistory().map((entry) => entry.id))
      const tree = render({ onPromptDelivered })
      ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
      await flushMicrotasks()
      expect(onPromptDelivered).not.toHaveBeenCalled()
      expect(harness.track).not.toHaveBeenCalled()
      const current = toast.getToasts().filter((entry) => !before.has(entry.id))
      if (kind === 'structured-session') {
        expect(dismiss).toHaveBeenCalled()
        expect(current).toEqual([])
      } else {
        expect(
          current.some((entry) => 'title' in entry && entry.title === 'selected:unconfirmed')
        ).toBe(true)
      }
      dismiss.mockRestore()
      vi.unstubAllGlobals()
    }
  )

  it('keeps selected-target thrown send errors undelivered', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    harness.sendMessageToAgent.mockRejectedValue(new Error('runtime unavailable'))
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(harness.track).not.toHaveBeenCalled()
  })

  it('revalidates the chosen target at click time and refuses stale rows', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render()
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'disabled',
        disabledReason: 'Agent status is stale'
      }
    ]
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()

    expect(harness.sendMessageToAgent).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('Agent status is stale')
  })

  it('refuses stale menu targets that disappear from target derivation before click', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render()
    harness.noteTargets = []
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()

    expect(harness.sendMessageToAgent).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('Terminal is no longer available')
  })

  it('keeps a working agent selectable and preserves the Working state text', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      ptyIdsByTabId: { [TAB_A]: ['pty-a'] }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        messageTarget: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A },
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: statusPaneKey,
        tabId: TAB_A,
        title: 'Terminal 1',
        agentType: 'claude',
        state: 'working'
      })
    ]

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')

    expect(item.props.disabled).toBe(false)
    expect(collectText(item)).toContain('Working')
    ;(item.props.onSelect as () => void)()
    await flushMicrotasks()
    expect(harness.sendMessageToAgent).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      target: { kind: 'terminal', tabId: TAB_A, leafId: LEAF_A }
    })
  })

  it('always offers the new-agent launcher', () => {
    const onPromptHandedOff = vi.fn()
    const tree = render({ onPromptHandedOff })

    expect(findByType(tree, 'QuickLaunchAgentMenuItems').props).toMatchObject({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'my notes',
      launchSource: 'notes_send',
      onPromptHandedOff
    })
  })

  // Notes held by other sends leave no prompt; do not launch an empty agent.
  it('disables the new-agent launcher when there is nothing left to send', () => {
    expect(findByType(render({ prompt: '' }), 'QuickLaunchAgentMenuItems').props.disabled).toBe(
      true
    )
    expect(findByType(render(), 'QuickLaunchAgentMenuItems').props.disabled).toBe(false)
  })
})
