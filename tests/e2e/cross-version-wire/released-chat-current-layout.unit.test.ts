import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabase } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { writeReleasedChat } from './released-chat-writers'
import type * as ReleaseCheckoutModule from './release-checkout'

vi.mock('./release-checkout', async (importOriginal) => ({
  ...(await importOriginal<typeof ReleaseCheckoutModule>()),
  materializeReleaseCheckout: async (ref: string) => ({
    ref,
    commit: 'working-tree',
    label: 'working-tree',
    root: process.cwd()
  })
}))

it('writes a Claude chat using the current layout as a future release checkout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-released-chat-current-'))
  try {
    const written = await writeReleasedChat('working-tree', 'claude', directory)
    expect(written.snapshot.items.length).toBeGreaterThan(3)
    expect(written.snapshot.submissions.map((entry) => entry.clientMessageId)).toEqual(
      expect.arrayContaining(['sent', 'refused'])
    )
    expect(written.cards).toHaveLength(2)
  } finally {
    await closeTestJournalHostDatabase(directory)
    rmSync(directory, { recursive: true, force: true })
  }
})
