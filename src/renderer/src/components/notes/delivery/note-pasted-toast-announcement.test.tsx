// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { showNotePastedToast, showWaitingNoteRefusalToast } from './note-pasted-toast'

const { reveal } = vi.hoisted(() => ({ reveal: vi.fn() }))
vi.mock('@/components/native-chat/selection-quotes/native-chat-workspace-selection', () => ({
  revealAgentTerminal: reveal
}))
vi.mock('@/store/index', () => ({
  useAppStore: (select: (state: { settings: { theme: string } }) => unknown) =>
    select({ settings: { theme: 'light' } })
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))

const args = {
  worktreeId: 'synthetic',
  target: { kind: 'terminal', tabId: 'tab', leafId: 'leaf' } as const,
  agentLabel: 'Stand-in',
  settleMs: 181_438,
  readyMessage: 'manual-submit marker'
}

async function paint(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  render(<Toaster closeButton />)
})
afterEach(async () => {
  document.body.removeAttribute('data-modal-overlay-open')
  for (const notice of toast.getToasts()) {
    if ('onDismiss' in notice) {
      notice.onDismiss?.(notice)
    }
    toast.dismiss(notice.id)
  }
  await paint()
  cleanup()
  vi.useRealTimers()
  reveal.mockReset()
})

it('shows the refused send after the earlier pasting notice was closed', async () => {
  act(() => showNotePastedToast(args))
  await paint()
  const close = document.querySelector<HTMLElement>('[data-close-button]')!
  fireEvent.click(close)
  await paint()
  expect(document.querySelector('[data-sonner-toast]')).toBeNull()
  act(() => showWaitingNoteRefusalToast(args))
  await paint()
  expect(document.querySelector('section[aria-live="polite"]')?.textContent).not.toContain(
    'manual-submit marker'
  )
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(document.querySelector('section[aria-live="polite"]')?.textContent).toContain(
    'manual-submit marker'
  )
  act(() => showWaitingNoteRefusalToast({ ...args, settleMs: 0 }))
  await paint()
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(document.querySelector('section[aria-live="polite"]')?.textContent).toContain(
    'manual-submit marker'
  )
})

it('replaces the old announcement and makes the refused-click action available above a modal', async () => {
  act(() => showNotePastedToast(args))
  await paint()
  const oldNotice = toast.getToasts().at(-1)!
  const region = document.querySelector('section[aria-live="polite"]')!
  let announced = false
  const observer = new MutationObserver((changes) => {
    announced ||= changes.some((change) => change.addedNodes.length > 0)
  })
  observer.observe(region, { childList: true, subtree: true, characterData: true })
  const modal = document.createElement('div')
  modal.dataset.slot = 'dialog-overlay'
  document.body.appendChild(modal)
  document.body.setAttribute('data-modal-overlay-open', '')
  await paint()
  fireEvent.click(document.querySelector<HTMLElement>('[data-sonner-toast] [data-button]')!)
  expect(reveal).not.toHaveBeenCalled()
  act(() => showWaitingNoteRefusalToast(args))
  await paint()
  expect(toast.getToasts().some((notice) => notice.id === oldNotice.id)).toBe(false)
  expect(announced).toBe(true)
  fireEvent.click(document.querySelector<HTMLElement>('[data-sonner-toast] [data-button]')!)
  expect(reveal).toHaveBeenCalledWith('synthetic', {
    kind: 'terminal',
    tabId: 'tab',
    leafId: 'leaf'
  })
  observer.disconnect()
  modal.remove()
})
