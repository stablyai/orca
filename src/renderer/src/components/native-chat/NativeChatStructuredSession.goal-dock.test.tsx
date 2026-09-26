// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
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
// The seam is CSS on DOM adjacency: the strip styles itself when a goal tab follows
// it, and the goal tab styles itself when the strip precedes it.
const STRIP_DOCK_RULE = /^group-has-\[\+\[([a-z-]+)\]\]\/tasks:(.+)$/
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

function sessionView(): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-goal"
        sessionId="session-goal"
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
}

function showStripAndGoal(status: AgentJournalThreadGoal['status'] = 'active'): void {
  mocks.monitoringBackgroundTasks = true
  mocks.backgroundTasks = [{ id: 'task-agent', kind: 'agent' }]
  mocks.threadGoal = { goal: goal(status), pending: false, change: vi.fn() }
}

describe('NativeChatStructuredSession task strip on the goal tab', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
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
    const goalRules = dockRules(goalTab, GOAL_DOCK_RULE)
    for (const { attribute } of stripRules) {
      expect(goalTab.hasAttribute(attribute)).toBe(true)
    }
    for (const { attribute } of goalRules) {
      expect(strip.hasAttribute(attribute)).toBe(true)
    }
    const stripUtilities = stripRules.map((rule) => rule.utility)
    expect(stripUtilities).toEqual(expect.arrayContaining(['rounded-b-none', 'shadow-none']))
    expect(goalRules.map((rule) => rule.utility)).toEqual(['rounded-t-none', 'border-t-0'])

    // Same width: the strip takes the goal tab's inset inside the shared column.
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
