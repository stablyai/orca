// @vitest-environment happy-dom
// Register preload/store seams before importing their consumers.
import {
  fixture,
  WORKSPACE,
  SUBJECT,
  SCOPE,
  addPrompt,
  publishView,
  AttentionPolicy,
  readCalls,
  dismissIds
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, StrictMode, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { agentSessionPromptAttentionKey } from '../../src/shared/agent-session-attention'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { useStructuredAgentSessionRead } from '@/components/native-chat/use-structured-agent-session-read'

const PROMPT_A = agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')
// Memoized like the pane's own target, so a rerender keeps the owner it already holds.
const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** The chat pane's read: shown means visible and viewed, as the transport derives both. */
function Pane({ shown, target }: { shown: boolean; target: RuntimeClientTarget }): null {
  useStructuredAgentSessionRead({ sessionId: SESSION, target, isVisible: shown, isViewed: shown })
  return null
}

function tree(options: {
  shown: boolean
  paneKey?: string
  strict?: boolean
  target?: RuntimeClientTarget
}) {
  const inner = createElement(
    Fragment,
    null,
    createElement(StructuredAgentSessionAttentionBridge),
    createElement(AttentionPolicy),
    createElement(Pane, {
      key: options.paneKey ?? 'pane',
      shown: options.shown,
      target: options.target ?? LOCAL
    })
  )
  return options.strict ? createElement(StrictMode, null, inner) : inner
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

/** A prompt raised while the user is elsewhere and the pane is hidden. */
async function promptWhileAway(options: { strict?: boolean } = {}) {
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  const screen = render(tree({ shown: false, strict: options.strict }))
  await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
  act(() => addPrompt('A'))
  await settle()
  expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
  return screen
}

/** The user opens the chat: the pane reads its history and views it. */
async function show(rerender: () => void): Promise<void> {
  fixture.hydrate = undefined
  act(() => useAppStore.getState().setActiveWorktree(WORKSPACE))
  rerender()
  await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
  await act(async () => fixture.hydrate?.())
  await settle()
}

function expectViewReadWithdraws(): void {
  expect(findStructuredAgentSessionReadOwner(SESSION, LOCAL)).toBeDefined()
  expect(readCalls()).toBeGreaterThan(0)
  expect(dismissIds()).toContain(PROMPT_A)
  expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
}

it('a view read under StrictMode still finds its owner and withdraws the alert', async () => {
  const screen = await promptWhileAway({ strict: true })
  await show(() => screen.rerender(tree({ shown: true, strict: true })))
  expectViewReadWithdraws()
})

it('a pane hidden by a worktree switch and shown again withdraws on view', async () => {
  const screen = await promptWhileAway()
  await show(() => screen.rerender(tree({ shown: true })))
  expect(dismissIds()).toContain(PROMPT_A)
  act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
  screen.rerender(tree({ shown: false }))
  await settle()
  act(() => addPrompt('B'))
  await settle()
  // An owner that already holds history resumes its journal stream instead of re-reading it.
  act(() => useAppStore.getState().setActiveWorktree(WORKSPACE))
  screen.rerender(tree({ shown: true }))
  await settle()
  act(() => publishView())
  await settle()
  expectViewReadWithdraws()
  expect(dismissIds()).toContain(agentSessionPromptAttentionKey(SCOPE, SESSION, 'B'))
})

it('a pane remounted in one commit (a tab move) keeps its owner findable', async () => {
  const screen = await promptWhileAway()
  // The new instance reads the still-held owner before the old one's cleanup releases it.
  screen.rerender(tree({ shown: false, paneKey: 'moved' }))
  await settle()
  await show(() => screen.rerender(tree({ shown: true, paneKey: 'moved' })))
  expectViewReadWithdraws()
})

it('a new target object for the same host keeps the owner findable', async () => {
  const screen = await promptWhileAway()
  screen.rerender(tree({ shown: false, target: { kind: 'local' } }))
  await settle()
  await show(() => screen.rerender(tree({ shown: true, target: { kind: 'local' } })))
  expectViewReadWithdraws()
})
