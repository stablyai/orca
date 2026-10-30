// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import * as attachmentReferences from '../../../../shared/native-chat-text-attachment-references'
import { NativeChatMarkdownImageOwnerProvider } from './native-chat-markdown-image-owner'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { agentSessionTabFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const attachmentMocks = vi.hoisted(() => ({ rpc: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: attachmentMocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { claudeGroupedQuestionPromptItems } from './native-chat-structured-question-test-fixtures'

const STRIP = '[data-native-chat-background-tasks]'
const GOAL = '[data-native-chat-thread-goal]'
// Docking depends on adjacent task/goal DOM elements and their group markers.
const STRIP_DOCK_RULE = /^\[\[data-native-chat-background-tasks\]:has\(\+\[([a-z-]+)\]\)_&\]:(.+)$/
const GOAL_DOCK_RULE = /^group-\[\[([a-z-]+)\]\+&\]\/goal:(.+)$/

function dockRules(root: Element, rule: RegExp): { attribute: string; utility: string }[] {
  return [root, ...root.querySelectorAll('*')].flatMap((element) =>
    [...element.classList].flatMap((token) => {
      const match = rule.exec(token)
      return match ? [{ attribute: match[1], utility: match[2] }] : []
    })
  )
}

function goal(status: AgentJournalThreadGoal['status']): AgentJournalThreadGoal {
  return {
    objective: 'Ship the parser',
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 60,
    createdAt: 1,
    updatedAt: 1
  }
}

function sessionView(
  agent: 'codex' | 'claude' = 'codex',
  target: RuntimeClientTarget = { kind: 'local' }
): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-goal"
        sessionId="session-goal"
        target={target}
        agent={agent}
      />
    </TooltipProvider>
  )
}

function showStripAndGoal(status: AgentJournalThreadGoal['status'] = 'active'): void {
  mocks.monitoringBackgroundTasks = true
  mocks.backgroundTasks = [{ id: 'task-agent', kind: 'agent' }]
  mocks.threadGoal = { goal: goal(status), pending: false, hostChanges: true, change: vi.fn() }
}

describe('structured goal attachment consumer', () => {
  const initial = useAppStore.getInitialState()
  const root = '/owner/agent-session-attachments/12345678-1234-1234-1234-123456789abc'
  const paths = [`${root}/a&copy;.txt`, `${root}/a©.txt`]
  const objective = `**Keep this objective** \` @${paths[0]} \` and @${paths[1]}`

  afterEach(() => {
    cleanup()
    useAppStore.setState(initial, true)
    resetStructuredSessionMocks()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each([true, false])(
    'opens exact goal sources through the structured caller and owning host (capable=%s)',
    async (capable) => {
      useAppStore.setState({
        worktreesByRepo: {
          repo: [worktreeFixture('wt-1', '/owner/repo', { hostId: 'runtime:goal-owner' })]
        },
        unifiedTabsByWorktree: {
          'wt-1': [agentSessionTabFixture('structured-tab-goal', 'wt-1')]
        },
        activeWorktreeId: 'wt-1',
        activeWorkspaceExecutionHostId: 'runtime:goal-owner'
      })
      const change = vi.fn(async () => true)
      mocks.threadGoal = {
        goal: { ...goal('active'), objective },
        pending: false,
        hostChanges: true,
        change
      }
      const contents = [
        `\ufeffexact &copy; source\r\n${'🙂'.repeat(10_000)}`,
        'opposite © sentinel'
      ]
      attachmentMocks.rpc.mockImplementation(async (target, method, request) => {
        expect(target).toEqual({ kind: 'environment', environmentId: 'goal-owner' })
        if (method === 'status.get') {
          return { capabilities: capable ? ['native-chat.text-attachment-read.v1'] : [] }
        }
        expect(method).toBe('agentSessionAttachment.readTextChunk')
        const index = paths.indexOf(request.path)
        expect(index).toBeGreaterThanOrEqual(0)
        const bytes = Buffer.from(contents[index]!)
        const chunk = bytes.subarray(request.offset, request.offset + request.length)
        return {
          snapshot: 'a'.repeat(64),
          size: bytes.length,
          bytesRead: chunk.length,
          contentBase64: chunk.toString('base64'),
          eof: request.offset + chunk.length === bytes.length
        }
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ui: { writeClipboardText: attachmentMocks.write } }
      })
      const view = render(
        <NativeChatMarkdownImageOwnerProvider
          tabId="structured-tab-goal"
          sessionId="session-goal"
          isVisible
        >
          {sessionView('codex', { kind: 'environment', environmentId: 'goal-owner' })}
        </NativeChatMarkdownImageOwnerProvider>
      )
      const body = screen.getByText(objective)
      expect(body.firstChild?.textContent).toBe(objective)
      expect(attachmentMocks.rpc).not.toHaveBeenCalled()
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Unsent draft' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Show full goal' }))
      for (const [index, path] of paths.entries()) {
        fireEvent.click(screen.getByRole('button', { name: path.slice(root.length + 1) }))
        if (capable) {
          await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Copy contents' })).toHaveProperty(
              'disabled',
              false
            )
          )
          fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
          await waitFor(() =>
            expect(attachmentMocks.write).toHaveBeenLastCalledWith(contents[index])
          )
        } else {
          await screen.findByText(
            'This host cannot open text attachments yet. Update Orca on that host, then retry.'
          )
          expect(
            attachmentMocks.rpc.mock.calls.every(([, method]) => method === 'status.get')
          ).toBe(true)
          expect(attachmentMocks.write).not.toHaveBeenCalled()
        }
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      }
      fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
      expect(change.mock.calls).toEqual([
        [{ kind: 'status', status: 'paused' }],
        [{ kind: 'clear' }]
      ])
      expect(mocks.threadGoal.goal?.objective).toBe(objective)
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty(
        'value',
        'Unsent draft'
      )
      view.unmount()
    }
  )

  it('keeps the default banner objective literal without recognition or source I/O', () => {
    const scan = vi.spyOn(attachmentReferences, 'nativeChatTextAttachmentPaths')
    render(
      <TooltipProvider>
        <NativeChatThreadGoalBanner
          goal={{ ...goal('active'), objective }}
          pending={false}
          hostChanges={false}
          sendUnavailable={false}
          isVisible
          runningTurn={null}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
    const body = screen.getByText(objective)
    expect(body.textContent).toBe(objective)
    fireEvent.click(screen.getByRole('button', { name: 'Show full goal' }))
    expect(body.textContent).toBe(objective)
    expect(scan).not.toHaveBeenCalled()
    expect(attachmentMocks.rpc).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'a&copy;.txt' })).toBeNull()
  })
})

describe('NativeChatStructuredSession task strip on the goal tab', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it('reveals a Claude goal cleared from the strip while preserving the composer draft', () => {
    const change = vi.fn(async () => true)
    mocks.threadGoal = { goal: goal('active'), pending: false, hostChanges: false, change }
    const view = render(sessionView('claude'))
    const composer = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })

    const clear = screen.getByRole('button', { name: 'Clear goal' })
    mocks.sendOut = true
    view.rerender(sessionView('claude'))
    expect(clear).toHaveProperty('disabled', true)
    fireEvent.click(clear)
    expect(change).not.toHaveBeenCalled()
    expect(mocks.revealLatest).not.toHaveBeenCalled()

    mocks.sendOut = false
    mocks.isWorking = true
    view.rerender(sessionView('claude'))
    expect(mocks.turnId).toBeNull()
    expect(clear).toHaveProperty('disabled', true)
    fireEvent.click(clear)
    expect(change).not.toHaveBeenCalled()
    expect(mocks.revealLatest).not.toHaveBeenCalled()

    mocks.isWorking = false
    view.rerender(sessionView('claude'))
    expect(clear).toHaveProperty('disabled', false)
    fireEvent.click(clear)

    expect(change).toHaveBeenCalledWith({ kind: 'clear' })
    expect(mocks.revealLatest).toHaveBeenCalledOnce()
    expect(composer).toHaveProperty('value', 'Keep this draft')
  })

  it('stacks the strip directly on the goal tab at the tab width, sharing one edge', () => {
    showStripAndGoal()
    render(sessionView())

    const strip = document.querySelector(STRIP)
    const goalTab = document.querySelector(GOAL)
    if (!strip || !goalTab) {
      throw new Error('expected both the task strip and the goal tab')
    }
    expect(strip.nextElementSibling).toBe(goalTab)
    // Group variants are inert without their group marker on the adjacent element.
    expect(strip.classList).toContain('group/tasks')
    expect(goalTab.classList).toContain('group/goal')

    const stripRules = dockRules(strip, STRIP_DOCK_RULE)
    // Its other rules join a tab strip stacked on another tab strip.
    const goalRules = dockRules(goalTab, GOAL_DOCK_RULE).filter(
      (rule) => rule.attribute === 'data-native-chat-background-tasks'
    )
    for (const { attribute } of stripRules) {
      expect(goalTab.hasAttribute(attribute)).toBe(true)
    }
    for (const { attribute } of goalRules) {
      expect(strip.hasAttribute(attribute)).toBe(true)
    }
    const stripUtilities = stripRules.map((rule) => rule.utility)
    expect(stripUtilities).toEqual(expect.arrayContaining(['rounded-b-none', 'shadow-none']))
    expect(goalRules.map((rule) => rule.utility)).toEqual(['rounded-t-none', 'border-t-0'])

    const goalInset = goalTab.firstElementChild
    expect(goalInset?.classList).toContain('px-2')
    expect(stripUtilities).toContain('px-2')
  })

  it('leaves the strip undocked when the goal tab does not render', () => {
    showStripAndGoal('complete')
    const { rerender } = render(sessionView())
    expect(document.querySelector(GOAL)).toBeNull()
    expect(document.querySelector(STRIP)?.nextElementSibling?.matches(GOAL) ?? false).toBe(false)

    const approval: AgentJournalRenderItem = {
      itemId: 'approval-item',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'approval',
        title: 'Allow command?',
        detail: 'pnpm test',
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
    showStripAndGoal('active')
    mocks.promptItems = [approval]
    rerender(sessionView())
    expect(document.querySelector(GOAL)).toBeNull()
    expect(document.querySelector(STRIP)).not.toBeNull()
  })

  it('restores the goal tab top edge when the strip goes away', () => {
    showStripAndGoal()
    const { rerender } = render(sessionView())
    expect(document.querySelector(GOAL)?.previousElementSibling?.matches(STRIP)).toBe(true)

    mocks.monitoringBackgroundTasks = false
    rerender(sessionView())
    expect(document.querySelector(STRIP)).toBeNull()
    expect(document.querySelector(GOAL)?.previousElementSibling?.matches(STRIP) ?? false).toBe(
      false
    )
  })
})

describe('NativeChatStructuredSession task strip above a pending prompt', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it.each([
    ['question', '[data-native-chat-question-card-mock]'],
    ['approval', '[data-native-chat-approval-card-mock]']
  ] as const)('renders the strip before the %s card, where the composer sat', (kind, card) => {
    mocks.monitoringBackgroundTasks = true
    mocks.backgroundTasks = [{ id: 'task-agent', kind: 'agent' }]
    mocks.promptItems =
      kind === 'question'
        ? claudeGroupedQuestionPromptItems
        : [
            {
              itemId: 'approval-item',
              revision: 1,
              sequence: 1,
              observedAt: 1,
              body: {
                kind: 'approval',
                title: 'Allow command?',
                detail: 'pnpm test',
                options: [{ id: 'allow', label: 'Allow' }],
                resolution: {
                  state: 'pending',
                  selectedOptionId: null,
                  resolvedBy: null,
                  resolvedAt: null
                }
              }
            }
          ]
    render(sessionView())

    const strip = document.querySelector(STRIP)
    const promptCard = document.querySelector(card)
    if (!strip || !promptCard) {
      throw new Error(`expected both the task strip and the ${kind} card`)
    }
    expect(strip.compareDocumentPosition(promptCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })
})

describe('NativeChatStructuredSession queued messages above the task strip', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it('stacks queued messages above the strip, so running shells and agents sit next to the composer', () => {
    showStripAndGoal()
    mocks.queuedCards = [
      {
        messageId: 'draft-1',
        position: 1,
        text: 'Reply with the word banana.',
        state: 'waiting',
        hold: 'turn'
      }
    ]
    render(sessionView())

    const queued = document.querySelector('[data-queued-message-id="draft-1"]')
    const strip = document.querySelector(STRIP)
    if (!queued || !strip) {
      throw new Error('expected both a queued message and the task strip')
    }
    expect(queued.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(strip.nextElementSibling).toBe(document.querySelector(GOAL))
  })
})
