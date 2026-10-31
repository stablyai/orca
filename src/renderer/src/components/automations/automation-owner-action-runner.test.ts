import type * as ScopedListClient from './automation-scoped-list-client'
import { describe, expect, it, vi } from 'vitest'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../../../shared/automation-owner-conflict'
const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('./automation-scoped-list-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ScopedListClient>()),
  updateOrphanAutomation: update
}))
import { updateOwnedAutomation } from './automation-owner-action-runner'

describe('owner conflict diagnostic through transport wrappers', () => {
  it.each([false, true])(
    'retains host-reselection reason with the existing token (flattened=%s)',
    async (flattened) => {
      const message = 'Edit the automation and reselect its host before running it.'
      const code = AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved
      update.mockRejectedValueOnce(
        flattened
          ? { code: 'runtime_error', message: `${message}: ${code}` }
          : new Error(`${message}: ${code}`)
      )
      await expect(
        updateOwnedAutomation(
          { kind: 'orphan-fenced', precondition: { selector: { kind: 'orphan' } } },
          { kind: 'desktop' },
          'saved',
          { name: 'Renamed' }
        )
      ).resolves.toEqual({
        status: 'conflict',
        conflict: { code, message, recovery: null }
      })
    }
  )
})
