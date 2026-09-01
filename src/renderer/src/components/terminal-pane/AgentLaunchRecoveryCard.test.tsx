// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentLaunchRecoveryCard } from './AgentLaunchRecoveryCard'
import type { AgentLaunchRecoveryActionId } from '@/lib/agent-launch-recovery-card'
import type {
  AgentLaunchFailureCode,
  PersistedAgentLaunchFailure
} from '../../../../shared/agent-launch-contract'

const mountedRoots: Root[] = []

function failure(code: AgentLaunchFailureCode): PersistedAgentLaunchFailure {
  return { code, version: 1, failureId: 'f1', intent: 'interactive', occurredAt: 0 }
}

async function renderCard(props: Parameters<typeof AgentLaunchRecoveryCard>[0]): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<AgentLaunchRecoveryCard {...props} />)
  })
}

function buttonLabels(): string[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].map(
    (button) => button.textContent ?? ''
  )
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('AgentLaunchRecoveryCard', () => {
  it('renders the failure copy and the code-specific recovery actions', async () => {
    await renderCard({ failure: failure('spawn_failed'), liveness: 'idle', onAction: vi.fn() })
    const text = document.body.textContent ?? ''
    expect(text).toContain("This workspace's agent didn't start.")
    expect(text).toContain("The agent couldn't be started. Try again.")
    expect(buttonLabels()).toEqual(['Retry', 'Choose agent'])
  })

  it('reports the resolved action id through onAction', async () => {
    const onAction = vi.fn<(id: AgentLaunchRecoveryActionId) => void>()
    await renderCard({ failure: failure('spawn_failed'), liveness: 'idle', onAction })
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    act(() => buttons[0].click())
    expect(onAction).toHaveBeenCalledExactlyOnceWith('retry')
  })

  it('offers only Open terminal when a matched terminal is still live', async () => {
    await renderCard({
      failure: failure('spawn_failed'),
      liveness: 'live-unattributed',
      onAction: vi.fn()
    })
    expect(buttonLabels()).toEqual(['Open terminal'])
  })

  it('offers Reconnect and Forget when the launch state is unknown', async () => {
    await renderCard({
      failure: failure('launch_state_unknown'),
      liveness: 'unknown',
      onAction: vi.fn()
    })
    expect(buttonLabels()).toEqual(['Reconnect', 'Forget launch…'])
  })

  it('disables every action while a recovery request is in flight', async () => {
    await renderCard({
      failure: failure('spawn_failed'),
      liveness: 'idle',
      busy: true,
      onAction: vi.fn()
    })
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.every((button) => button.disabled)).toBe(true)
  })
})
