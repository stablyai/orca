import { expect, it, vi } from 'vitest'
import {
  ptySessionIdentity,
  type PtyListedSession
} from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { reconcileResourceSessionListing } from './resource-session-inventory'

it.each([300, 3000])('reconciles an unrelated spawn with %i retained identities', (size) => {
  const session = (id: string): PtyListedSession => ({
    id,
    incarnationId: 'active',
    cwd: '',
    title: 'shell',
    agentOwnership: 'absent'
  })
  const rows = Array.from({ length: size }, (_, index) => session(`pty-${index}`))
  const previous = new Map(rows.map((row) => [ptySessionIdentity(row), row]))
  const lookUpPreviousIdentity = vi.spyOn(previous, 'has')
  const replacement = reconcileResourceSessionListing(
    [...rows.slice(0, 1), session('unrelated'), ...rows.slice(1)],
    previous,
    new Set(),
    { compareExisting: true, trackRemovals: true }
  )

  expect(replacement.retained).toBe(size)
  expect(replacement.deduped.size).toBe(size + 1)
  expect(lookUpPreviousIdentity).toHaveBeenCalledExactlyOnceWith('["unrelated","active"]')
})
