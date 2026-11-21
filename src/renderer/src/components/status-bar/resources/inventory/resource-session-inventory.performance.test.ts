import { expect, it, vi } from 'vitest'
import {
  ptySessionIdentity,
  type PtyListedSession
} from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import {
  reconcileResourceSessionListing,
  type ListedIncarnations
} from './resource-session-inventory'

it.each([300, 3000])('reconciles an unrelated spawn with %i retained identities', (size) => {
  const session = (id: string): PtyListedSession => ({
    id,
    incarnationId: 'active',
    cwd: '',
    title: 'shell',
    agentOwnership: 'absent'
  })
  const rows = Array.from({ length: size }, (_, index) => session(`pty-${index}`))
  const incarnations: ListedIncarnations = new Map()
  const previous = reconcileResourceSessionListing(rows, new Map(), incarnations, 1, new Set(), {
    compareExisting: false,
    trackRemovals: false
  }).deduped
  const lookUpPreviousIdentity = vi.spyOn(previous, 'has')
  const visitPreviousEntries = vi.spyOn(previous, 'entries')
  const visitPreviousValues = vi.spyOn(previous, 'values')
  const replacement = reconcileResourceSessionListing(
    [...rows.slice(0, 1), session('unrelated'), ...rows.slice(1)],
    previous,
    incarnations,
    2,
    new Set(),
    { compareExisting: true, trackRemovals: true }
  )

  expect(replacement.retained).toBe(size)
  expect(replacement.deduped.size).toBe(size + 1)
  expect(replacement.deduped.has(ptySessionIdentity(session('unrelated')))).toBe(true)
  expect(lookUpPreviousIdentity).not.toHaveBeenCalled()
  expect(visitPreviousEntries).not.toHaveBeenCalled()
  expect(visitPreviousValues).not.toHaveBeenCalled()
})
