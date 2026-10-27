// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JiraAttachmentImage } from './jira-attachment-image'

const { acquire, release, listeners } = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  listeners: new Set<(environmentId: string | null) => void>()
}))
vi.mock('@/runtime/runtime-jira-image-cache', () => ({
  acquireJiraImageUrl: acquire,
  hasCachedJiraImage: () => false,
  onJiraImageCacheInvalidated: (listener: (environmentId: string | null) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}))
const target = { kind: 'environment' as const, environmentId: 'first-host' }
beforeEach(() => {
  acquire.mockReset()
  release.mockReset()
  listeners.clear()
})
afterEach(cleanup)

it('removes the previous image immediately when its mounted owner or reference changes', async () => {
  acquire
    .mockResolvedValueOnce({ url: 'blob:first', release })
    .mockImplementationOnce(() => new Promise(() => {}))
  const view = render(
    <JiraAttachmentImage target={target} reference="first" alt="shot" compact={false} />
  )
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first'))
  view.rerender(
    <JiraAttachmentImage
      target={{ kind: 'environment', environmentId: 'second-host' }}
      reference="second"
      alt="shot"
      compact={false}
    />
  )
  expect(screen.queryByRole('img')).toBeNull()
  expect(release).toHaveBeenCalledOnce()
})

it('lets a new reference load after the previous reference failed', async () => {
  acquire
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce({ url: 'blob:second', release })
  const view = render(
    <JiraAttachmentImage target={target} reference="first" alt="shot" compact={false} />
  )
  await waitFor(() => expect(acquire).toHaveBeenCalledOnce())
  await new Promise((resolve) => setTimeout(resolve, 0))
  view.rerender(
    <JiraAttachmentImage target={target} reference="second" alt="shot" compact={false} />
  )
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second'))
})

it('reacquires the same reference after disconnect and reconnect invalidations', async () => {
  acquire
    .mockResolvedValueOnce({ url: 'blob:first', release })
    .mockRejectedValueOnce(new Error('disconnected'))
    .mockResolvedValueOnce({ url: 'blob:reconnected', release })
  render(<JiraAttachmentImage target={target} reference="same" alt="shot" compact={false} />)
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first'))
  await act(async () => listeners.forEach((listener) => listener('first-host')))
  expect(screen.queryByRole('img')).toBeNull()
  await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
  await act(async () => listeners.forEach((listener) => listener('other-host')))
  expect(acquire).toHaveBeenCalledTimes(2)
  await act(async () => listeners.forEach((listener) => listener('first-host')))
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:reconnected'))
  expect(acquire).toHaveBeenCalledTimes(3)
  expect(release).toHaveBeenCalledOnce()
})

it('fences a pending rejection synchronously when its cache is invalidated', async () => {
  let requestSignal: AbortSignal | undefined
  let rejectFirst: ((reason: Error) => void) | undefined
  acquire
    .mockImplementationOnce((_target, _reference, signal: AbortSignal) => {
      requestSignal = signal
      return new Promise((_resolve, reject) => {
        rejectFirst = reject
      })
    })
    .mockResolvedValueOnce({ url: 'blob:retried', release })
  render(<JiraAttachmentImage target={target} reference="same" alt="shot" compact={false} />)
  await waitFor(() => expect(acquire).toHaveBeenCalledOnce())
  await act(async () => {
    listeners.forEach((listener) => listener('first-host'))
    expect(requestSignal?.aborted).toBe(true)
    rejectFirst?.(new Error('Cache invalidated'))
    await Promise.resolve()
  })
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:retried'))
  expect(acquire).toHaveBeenCalledTimes(2)
})
