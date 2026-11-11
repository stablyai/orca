// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sonner } = vi.hoisted(() => ({
  sonner: {
    custom:
      vi.fn<(render: () => React.ReactNode, options: { id: string; className?: string }) => void>(),
    dismiss: vi.fn<(id: string) => void>()
  }
}))
vi.mock('sonner', () => ({ toast: sonner }))

import {
  cloudToastInternalId,
  hideCloudToast,
  READD_QUIET_MS,
  resetCloudToasts,
  setCloudToastContext,
  showCloudToast,
  type CloudToastView
} from './cloud-toast-stack'

const AGENT = 'orca-cloud-agent-not-started'
const PUSH = 'cloud-setup:env-1'

function agentView(
  text = 'Claude isn’t set up for Orca Cloud, so it didn’t start.'
): CloudToastView {
  return {
    priority: 'action',
    lines: [
      {
        key: 'agent',
        text,
        action: { label: 'Set up Claude once', primary: true, onClick: vi.fn() }
      }
    ]
  }
}
const pushView: CloudToastView = {
  priority: 'warning',
  lines: [{ key: 'git.push', text: 'Orca Cloud can read stablyai/orca but can’t push yet.' }]
}
const infoView: CloudToastView = { priority: 'info', lines: [{ key: 'i', text: 'FYI' }] }

/** Sonner's stack as the mock saw it: internal ids in the order they were added (bottom → top). */
function sonnerStack(): string[] {
  const dismissed = new Set(sonner.dismiss.mock.calls.map(([id]) => id))
  const order: string[] = []
  for (const [, options] of sonner.custom.mock.calls) {
    if (options.className === 'cloud-toast-gone') {
      continue
    }
    if (!order.includes(options.id)) {
      order.push(options.id)
    }
  }
  return order.filter((id) => !dismissed.has(id))
}

/** Renders what sonner would render for an internal id (its latest custom content). */
function renderInternal(internalId: string) {
  const call = sonner.custom.mock.calls.findLast(
    ([, options]) => options.id === internalId && options.className !== 'cloud-toast-gone'
  )
  return render(<>{call?.[0]()}</>)
}

beforeEach(() => {
  resetCloudToasts()
  sonner.custom.mockClear()
  sonner.dismiss.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('cloud toast stack (DS-q)', () => {
  it('keeps the action-required prompt on top when a warning arrives after it', () => {
    showCloudToast(AGENT, agentView(), {}, 0)
    showCloudToast(PUSH, pushView, {}, 10)
    // Top of the stack (last added) is the agent prompt, under a fresh internal id.
    const stackNow = sonnerStack()
    expect(stackNow.at(-1)).toBe(cloudToastInternalId(AGENT))
    expect(stackNow.at(-1)).not.toBe(`${AGENT}#0`)
    expect(stackNow).toEqual([cloudToastInternalId(PUSH), cloudToastInternalId(AGENT)])
  })

  it('orders action, then warning, then info; recency breaks ties inside a tier', () => {
    showCloudToast('w-old', pushView, {}, 0)
    showCloudToast(AGENT, agentView(), {}, 1)
    showCloudToast('info', infoView, {}, 2)
    showCloudToast('w-new', pushView, {}, 3)
    expect(sonnerStack()).toEqual([
      cloudToastInternalId('info'),
      cloudToastInternalId('w-old'),
      cloudToastInternalId('w-new'),
      cloudToastInternalId(AGENT)
    ])
  })

  it('needs no re-add when toasts already arrive in priority order', () => {
    showCloudToast(PUSH, pushView, {}, 0)
    showCloudToast(AGENT, agentView(), {}, 1)
    expect(sonner.dismiss).not.toHaveBeenCalled()
    expect(cloudToastInternalId(AGENT)).toBe(`${AGENT}#0`)
  })

  it('guard 1: a re-added card is not announced again; its first appearance is', () => {
    vi.useFakeTimers({ now: 1_000 })
    showCloudToast(AGENT, agentView(), {}, 1_000)
    const first = renderInternal(cloudToastInternalId(AGENT) ?? '')
    expect(
      first.container.querySelector('[data-cloud-toast]')?.getAttribute('aria-hidden')
    ).toBeNull()
    first.unmount()

    showCloudToast(PUSH, pushView, {}, 1_000)
    const readded = renderInternal(cloudToastInternalId(AGENT) ?? '')
    const card = (): Element | null => readded.container.querySelector('[data-cloud-toast]')
    expect(card()?.getAttribute('aria-hidden')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(READD_QUIET_MS)
    })
    expect(card()?.getAttribute('aria-hidden')).toBeNull()
  })

  it('guard 2: the re-add skips the enter animation and the old card leaves without one', () => {
    showCloudToast(AGENT, agentView(), {}, 0)
    showCloudToast(PUSH, pushView, {}, 1)
    const calls = sonner.custom.mock.calls
    const gone = calls.find(([, options]) => options.className === 'cloud-toast-gone')
    expect(gone?.[1].id).toBe(`${AGENT}#0`)
    expect(sonner.dismiss).toHaveBeenCalledWith(`${AGENT}#0`)
    const readd = calls.find(([, options]) => options.id === cloudToastInternalId(AGENT))
    expect(readd?.[1].className).toBe('cloud-toast-readd')
  })

  it('guard 3: a re-add keeps the in-progress state, and × closes the same logical toast', () => {
    const onDismiss = vi.fn()
    showCloudToast(AGENT, agentView(), { onDismiss }, 0)
    // Mid sign-in, then a warning arrives and the prompt is re-added on top.
    showCloudToast(
      AGENT,
      agentView('Finish signing in to Claude in your browser…'),
      { onDismiss },
      1
    )
    showCloudToast(PUSH, pushView, {}, 2)
    const internal = cloudToastInternalId(AGENT) ?? ''
    expect(internal).not.toBe(`${AGENT}#0`)
    renderInternal(internal)
    expect(screen.getByText('Finish signing in to Claude in your browser…')).toBeTruthy()
    // An update after the re-add still lands on the same card.
    act(() => {
      showCloudToast(AGENT, agentView('Saving…'), { onDismiss }, 3)
    })
    expect(screen.getByText('Saving…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(sonner.dismiss).toHaveBeenCalledWith(internal)
    expect(cloudToastInternalId(AGENT)).toBeNull()
  })

  describe('workspace scope (N-03)', () => {
    const W1 = 'w1'
    const inWorkspace = (id: string | null) => ({ activeView: 'terminal', activeWorktreeId: id })

    it("shows a workspace's notice only in that workspace, and quietly again on return", () => {
      vi.useFakeTimers({ now: 1_000 })
      // The stack reads the app's context on its first toast; then the user is in w1.
      showCloudToast(PUSH, pushView, { scope: { workspaceId: W1 } }, 1_000)
      setCloudToastContext(inWorkspace(W1), 1_000)
      expect(sonnerStack()).toEqual([cloudToastInternalId(PUSH)])
      const first = cloudToastInternalId(PUSH)

      // Another workspace: gone from sonner (no focus or tab stops left behind).
      setCloudToastContext(inWorkspace('w2'), 1_100)
      expect(sonnerStack()).toEqual([])
      expect(sonner.dismiss).toHaveBeenCalledWith(first)

      // Back: shown again, under a fresh id, without a slide-in or a second announcement.
      setCloudToastContext(inWorkspace(W1), 1_200)
      const back = cloudToastInternalId(PUSH) ?? ''
      expect(back).not.toBe(first)
      expect(sonnerStack()).toEqual([back])
      const call = sonner.custom.mock.calls.findLast(([, options]) => options.id === back)
      expect(call?.[1].className).toBe('cloud-toast-readd')
      const view = renderInternal(back)
      expect(view.container.querySelector('[data-cloud-toast]')?.getAttribute('aria-hidden')).toBe(
        'true'
      )
    })

    it('never shows over Settings or another page, scoped or not', () => {
      showCloudToast(PUSH, pushView, { scope: { workspaceId: W1 } }, 0)
      showCloudToast('info', infoView, {}, 0)
      setCloudToastContext(inWorkspace(W1), 0)
      expect(sonnerStack()).toHaveLength(2)
      setCloudToastContext({ activeView: 'settings', activeWorktreeId: W1 }, 1)
      expect(sonnerStack()).toEqual([])
      setCloudToastContext(inWorkspace(W1), 2)
      expect(sonnerStack()).toHaveLength(2)
    })

    it('a toast closed while hidden stays closed', () => {
      showCloudToast(PUSH, pushView, { scope: { workspaceId: W1 } }, 0)
      setCloudToastContext(inWorkspace(W1), 0)
      setCloudToastContext(inWorkspace('w2'), 1)
      hideCloudToast(PUSH)
      setCloudToastContext(inWorkspace(W1), 2)
      expect(sonnerStack()).toEqual([])
    })
  })
})
