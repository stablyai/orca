// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { watchForSettingsDeepLinkTarget } from './settings-deep-link-target-watcher'

const watches: { cancel: () => void }[] = []
afterEach(() => {
  for (const watch of watches.splice(0)) {
    watch.cancel()
  }
  document.body.replaceChildren()
  vi.useRealTimers()
})
function pending() {
  const root = document.createElement('div')
  root.dataset.state = 'pending'
  document.body.append(root)
  const reveal = vi.fn()
  const fallback = vi.fn()
  const watch = watchForSettingsDeepLinkTarget({
    root,
    timeoutMs: 30_000,
    cancelOnInteraction: true,
    waitForLayout: true,
    isTargetPresent: () => Boolean(root.querySelector('#arriving-agent')),
    isTargetUnavailable: () => root.dataset.state !== 'pending',
    onTargetPresent: reveal,
    onTimeout: fallback
  })
  watches.push(watch)
  const arrive = () => {
    const row = document.createElement('div')
    row.id = 'arriving-agent'
    root.append(row)
    root.dataset.state = 'ready'
  }
  return { root, reveal, fallback, arrive }
}
async function mutations(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50)
}

it('finishes a delayed inventory jump after the former five-second deadline', async () => {
  vi.useFakeTimers()
  const { arrive, reveal, fallback } = pending()
  await vi.advanceTimersByTimeAsync(6000)
  arrive()
  await mutations()
  expect(reveal).toHaveBeenCalled()
  expect(fallback).not.toHaveBeenCalled()
})

it.each(['scroll', 'input', 'click', 'focusin', 'keydown'])(
  'cancels a pending inventory jump after user %s',
  async (event) => {
    vi.useFakeTimers()
    const { root, arrive, reveal } = pending()
    if (event === 'scroll') {
      root.scrollTop = 80
    }
    fireEvent(root, new Event(event, { bubbles: true }))
    arrive()
    await mutations()
    expect(reveal).not.toHaveBeenCalled()
  }
)

it('settles failed inventory without jumping if a row later appears', async () => {
  vi.useFakeTimers()
  const { root, fallback, arrive, reveal } = pending()
  root.dataset.state = 'failed'
  await mutations()
  expect(fallback).toHaveBeenCalled()
  arrive()
  await mutations()
  expect(reveal).not.toHaveBeenCalled()
})

it('lets interaction cancel after the row arrives but before its layout settles', async () => {
  vi.useFakeTimers()
  const { root, arrive, reveal } = pending()
  arrive()
  await vi.advanceTimersByTimeAsync(0)
  fireEvent.click(root)
  await mutations()
  expect(reveal).not.toHaveBeenCalled()
})

it('stops waiting at thirty seconds without a late jump', async () => {
  vi.useFakeTimers()
  const { fallback, arrive, reveal } = pending()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fallback).toHaveBeenCalled()
  arrive()
  await mutations()
  expect(reveal).not.toHaveBeenCalled()
})
