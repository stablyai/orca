// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeAgentLaunchFailure } from './WorktreeAgentLaunchFailure'
import type {
  AgentLaunchRecoveryActionId,
  AgentLaunchRecoveryCardModel
} from '@/lib/agent-launch-recovery-card'
import type {
  AgentLaunchFailureCode,
  AgentLaunchIntentKind,
  PersistedAgentLaunchFailure
} from '../../../../shared/agent-launch-contract'

const mountedRoots: Root[] = []

function failure(
  intent: AgentLaunchIntentKind,
  code: AgentLaunchFailureCode = 'spawn_failed'
): PersistedAgentLaunchFailure {
  return { code, version: 1, failureId: 'f1', intent, occurredAt: 0 }
}

async function renderCard(props: Parameters<typeof WorktreeAgentLaunchFailure>[0]): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<WorktreeAgentLaunchFailure {...props} />)
  })
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
}

function buttonLabels(): string[] {
  return buttons().map((button) => button.textContent ?? '')
}

const forgetThenOpen: AgentLaunchRecoveryCardModel = {
  primary: 'forget-launch',
  secondary: ['open-terminal']
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('WorktreeAgentLaunchFailure', () => {
  it('renders the owner-scoped title, failure copy, and supplied actions', async () => {
    await renderCard({
      failure: failure('automation'),
      actions: forgetThenOpen,
      onAction: vi.fn()
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain("An automation's agent didn't start.")
    expect(text).toContain("The agent couldn't be started. Try again.")
    expect(buttonLabels()).toEqual(['Forget launch…', 'Open terminal'])
  })

  it('names the owning record per launch intent', async () => {
    const titles: Record<'orchestration' | 'background' | 'interactive', string> = {
      orchestration: "A task's agent didn't start.",
      background: "A background agent didn't start.",
      interactive: "An agent launch didn't finish."
    }
    for (const [intent, title] of Object.entries(titles)) {
      await renderCard({
        failure: failure(intent as AgentLaunchIntentKind),
        actions: forgetThenOpen,
        onAction: vi.fn()
      })
      expect(document.body.textContent ?? '').toContain(title)
      for (const root of mountedRoots.splice(0)) {
        act(() => root.unmount())
      }
      document.body.innerHTML = ''
    }
  })

  it('reports the primary action id through onAction', async () => {
    const onAction = vi.fn<(id: AgentLaunchRecoveryActionId) => void>()
    await renderCard({
      failure: failure('orchestration'),
      actions: { primary: 'retry', secondary: ['forget-launch'] },
      onAction
    })
    act(() => buttons()[0].click())
    expect(onAction).toHaveBeenCalledExactlyOnceWith('retry')
  })

  it('reports a secondary Forget through onAction', async () => {
    const onAction = vi.fn<(id: AgentLaunchRecoveryActionId) => void>()
    await renderCard({
      failure: failure('orchestration'),
      actions: { primary: 'retry', secondary: ['forget-launch'] },
      onAction
    })
    act(() => buttons()[1].click())
    expect(onAction).toHaveBeenCalledExactlyOnceWith('forget-launch')
  })

  it('disables every action while a recovery request is in flight', async () => {
    await renderCard({
      failure: failure('automation'),
      actions: forgetThenOpen,
      busy: true,
      onAction: vi.fn()
    })
    expect(buttons().every((button) => button.disabled)).toBe(true)
  })
})
