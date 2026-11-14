// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () =>
  moduleFactories.structuredAgentSessionCall()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () =>
  moduleFactories.structuredAgentSessionSubscriptions()
)
vi.mock('../../session/structured/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../../appearance/use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('../../links/actions/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../pane/ownership/use-native-chat-tab-owner', () =>
  moduleFactories.useNativeChatTabOwner()
)
vi.mock('../../links/actions/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('../../composer/NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('../../host-access/NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('../../prompts/NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('../../prompts/NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    resetStructuredSessionMocks()
    vi.restoreAllMocks()
  })

  // Create fresh elements for rerenders; React can skip an identical element.
  const claudeSessionView = (tabId: string, sessionId: string) => (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId={tabId}
      sessionId={sessionId}
      target={{ kind: 'local' }}
      agent="claude"
    />
  )

  it('tracks concurrent task stops independently: a confirmed one holds its row, a failed one clears', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [
      { id: 'task-one', kind: 'command', description: 'First task' },
      { id: 'task-two', kind: 'command', description: 'Second task' }
    ]
    let finishFirst!: (value: unknown) => void
    let finishSecond!: (value: unknown) => void
    mocks.stopBackgroundTask.mockImplementation(
      (_sessionId: string, taskId?: string) =>
        new Promise((resolve) => {
          if (taskId === 'task-one') {
            finishFirst = resolve
          } else {
            finishSecond = resolve
          }
        })
    )

    const { rerender } = render(
      claudeSessionView('structured-tab-concurrent-background', 'session-concurrent-background')
    )
    fireEvent.click(screen.getByRole('button', { name: '2 shells — 2 working' }))
    const firstStop = screen.getByRole('button', { name: 'Stop First task' })
    const secondStop = screen.getByRole('button', { name: 'Stop Second task' })

    fireEvent.click(firstStop)
    fireEvent.click(secondStop)
    expect((firstStop as HTMLButtonElement).disabled).toBe(true)
    expect((secondStop as HTMLButtonElement).disabled).toBe(true)

    // Confirmed before its row leaves: the button stays in its stopping state, never Stop again.
    await act(async () => finishFirst({ cancelled: true }))
    expect((firstStop as HTMLButtonElement).disabled).toBe(true)
    expect((secondStop as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finishSecond(null))
    await waitFor(() => expect((secondStop as HTMLButtonElement).disabled).toBe(false))
    expect((firstStop as HTMLButtonElement).disabled).toBe(true)

    mocks.backgroundTasks = [{ id: 'task-two', kind: 'command', description: 'Second task' }]
    rerender(
      claudeSessionView('structured-tab-concurrent-background', 'session-concurrent-background')
    )
    expect(screen.queryByRole('button', { name: 'Stop First task' })).toBeNull()
    // The same task listed again is one the Stop did not end.
    mocks.backgroundTasks = [
      { id: 'task-one', kind: 'command', description: 'First task' },
      { id: 'task-two', kind: 'command', description: 'Second task' }
    ]
    rerender(
      claudeSessionView('structured-tab-concurrent-background', 'session-concurrent-background')
    )
    const firstAgain = screen.getByRole('button', { name: 'Stop First task' })
    expect(firstAgain.hasAttribute('disabled')).toBe(false)
  })

  it('keeps a stale session stop result from clearing the current session pending state', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [{ id: 'task-one', kind: 'command', description: 'Shared task' }]
    let finishOld!: (value: unknown) => void
    let finishCurrent!: (value: unknown) => void
    mocks.stopBackgroundTask.mockImplementation(
      (sessionId: string) =>
        new Promise((resolve) => {
          if (sessionId === 'session-old') {
            finishOld = resolve
          } else {
            finishCurrent = resolve
          }
        })
    )
    const { rerender } = render(claudeSessionView('structured-tab-stale-background', 'session-old'))
    fireEvent.click(screen.getByRole('button', { name: '1 shell command — working' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Shared task' }))

    rerender(claudeSessionView('structured-tab-stale-background', 'session-current'))
    fireEvent.click(screen.getByRole('button', { name: '1 shell command — working' }))
    const currentStop = screen.getByRole('button', { name: 'Stop Shared task' })
    expect((currentStop as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(currentStop)
    expect((currentStop as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finishOld({ cancelled: true }))
    expect((currentStop as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finishCurrent({ cancelled: false }))
    await waitFor(() => expect((currentStop as HTMLButtonElement).disabled).toBe(false))
  })
})
