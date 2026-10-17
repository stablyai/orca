// @vitest-environment happy-dom

import { memo, useContext } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { NativeChatStructuredMessageProviders } from './NativeChatStructuredMessageProviders'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { legacySingleQuestionPromptItems } from './native-chat-structured-question-test-fixtures'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const report = vi.hoisted(() => vi.fn())
const renderReply = vi.fn()
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: report
}))

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  report.mockClear()
  renderReply.mockClear()
})

/** Counts context-driven renders while keeping the consumer memoized like a message row. */
const ReplyProbe = memo(function ReplyProbe() {
  renderReply()
  const reply = useContext(NativeChatAsyncQuestionContext)
  return <button onClick={() => reply?.send('answer')}>Reply</button>
})

const LOCAL_TARGET = { kind: 'local' } as const

/** Exercises the provider with a mocked session controller and a real context consumer. */
function Session({
  target = LOCAL_TARGET,
  blocked = false,
  installBlocked = false,
  onSubmitted = vi.fn()
}: {
  target?: RuntimeClientTarget
  blocked?: boolean
  installBlocked?: boolean
  onSubmitted?: () => void
}) {
  const pane = { sessionId: 'session-1', target }
  const controller = useStructuredAgentSession({ ...pane, agent: 'codex', isVisible: true })
  const continuation = useContext(NativeChatOrcaStopContext)
  return (
    <NativeChatStructuredMessageProviders
      controller={controller}
      pane={pane}
      blocked={blocked}
      installBlocked={installBlocked}
      continuation={continuation}
      claudeSignIn={null}
      onSubmitted={onSubmitted}
    >
      <ReplyProbe />
    </NativeChatStructuredMessageProviders>
  )
}

it.each([{ kind: 'local' }, { kind: 'environment', environmentId: 'remote-1' }] as const)(
  'reports an accepted answer to its $kind session',
  (target) => {
    const onSubmitted = vi.fn()
    render(<Session target={target} onSubmitted={onSubmitted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('answer', [], { immediate: true })
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      target.kind === 'local' ? null : target.environmentId
    )
  }
)

it.each(['blocked', 'install', 'send', 'prompt'])(
  'refuses an answer during %s without reporting input',
  (reason) => {
    mocks.sendOut = reason === 'send'
    mocks.promptItems = reason === 'prompt' ? legacySingleQuestionPromptItems : []
    const onSubmitted = vi.fn()
    render(
      <Session
        blocked={reason === 'blocked'}
        installBlocked={reason === 'install'}
        onSubmitted={onSubmitted}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(mocks.send).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  }
)

it('does not report a reply the sender refused', () => {
  mocks.send.mockReturnValue(false)
  const onSubmitted = vi.fn()
  render(<Session onSubmitted={onSubmitted} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  expect(mocks.send).toHaveBeenCalledOnce()
  expect(onSubmitted).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('keeps rows stable during stream updates while using the latest send and reveal callbacks', () => {
  const oldSend = mocks.send
  const oldSubmitted = vi.fn()
  const nextSubmitted = vi.fn()
  const view = render(
    <Session
      target={{ kind: 'environment', environmentId: 'remote-1' }}
      onSubmitted={oldSubmitted}
    />
  )
  expect(renderReply).toHaveBeenCalledTimes(1)
  mocks.send = vi.fn<(text: string, attachments?: unknown[]) => boolean>(() => true)
  try {
    view.rerender(
      <Session
        target={{ kind: 'environment', environmentId: 'remote-1' }}
        onSubmitted={nextSubmitted}
      />
    )
    expect(renderReply).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(oldSend).not.toHaveBeenCalled()
    expect(oldSubmitted).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('answer', [], { immediate: true })
    expect(nextSubmitted).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledExactlyOnceWith('session-1', 'remote-1')
    view.rerender(<Session blocked onSubmitted={nextSubmitted} />)
    expect(renderReply).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(mocks.send).toHaveBeenCalledTimes(1)
  } finally {
    mocks.send = oldSend
  }
})
