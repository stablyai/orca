import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type * as OperationModule from './link-preference-operation'
import type { LinkPreferenceWriter } from './link-preference-operation'
import type { LinkPreferenceFields } from './link-preference-publication'
import { getDefaultPersistedState } from '../../../../../shared/orca-profiles/constants'

const accepted = (fields: LinkPreferenceFields): GlobalSettings => ({
  ...getDefaultPersistedState('/home/tester').settings,
  ...fields
})

const notices = vi.hoisted((): { shown: unknown[]; dismissed: number } => ({
  shown: [],
  dismissed: 0
}))
vi.mock('./link-preference-notice', () => ({
  showLinkPreferenceNotice: (notice: unknown) => notices.shown.push(notice),
  dismissLinkPreferenceNotice: () => {
    notices.dismissed += 1
  }
}))

let ops: typeof OperationModule

const ORCA = {
  openLinksInApp: true,
  httpLinkClickBehavior: 'open',
  openLinksInAppPreferencePrompted: true
} as const

function writer(overrides: Partial<LinkPreferenceWriter> = {}): LinkPreferenceWriter & {
  writes: unknown[]
} {
  const writes: unknown[] = []
  return {
    writes,
    updateSettingsOrThrow: async (updates, onAcknowledged) => {
      writes.push(updates)
      onAcknowledged(accepted(updates))
    },
    reconcile: async () => null,
    ...overrides
  }
}

beforeEach(async () => {
  vi.resetModules()
  notices.shown = []
  notices.dismissed = 0
  ops = await import('./link-preference-operation')
})

describe('Remember operation', () => {
  it('writes once after admission and announces the saved browser', async () => {
    const w = writer()
    const op = ops.beginLinkPreferenceOperation('remember', ORCA)
    expect(ops.admitLinkPreferenceOperation(op, 'admitted')).toBe(true)
    await ops.writeLinkPreference(op, w)
    expect(w.writes).toEqual([ORCA])
    expect(notices.shown).toEqual([{ kind: 'saved', openLinksInApp: true }])
  })

  it.each(['refused', 'failed', 'superseded'] as const)(
    'never writes when the open was %s',
    async (outcome) => {
      const w = writer()
      const op = ops.beginLinkPreferenceOperation('remember', ORCA)
      expect(ops.admitLinkPreferenceOperation(op, outcome)).toBe(false)
      await ops.writeLinkPreference(op, w)
      expect(w.writes).toEqual([])
      expect(notices.shown).toEqual([])
    }
  )

  it('yields to a newer choice in this window made before admission', async () => {
    const w = writer()
    const remember = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.beginLinkPreferenceOperation('settings', { httpLinkClickBehavior: 'ask' })
    expect(ops.admitLinkPreferenceOperation(remember, 'admitted')).toBe(false)
    await ops.writeLinkPreference(remember, w)
    expect(w.writes).toEqual([])
  })

  it('yields to another window choosing differently before admission', async () => {
    const w = writer()
    const remember = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.noteIncomingLinkPatch({ httpLinkClickBehavior: 'ask' }, { httpLinkClickBehavior: 'open' })
    expect(ops.admitLinkPreferenceOperation(remember, 'admitted')).toBe(false)
    await ops.writeLinkPreference(remember, w)
    expect(w.writes).toEqual([])
  })

  it('yields when another window re-picks Ask and only the prompted flag changes', async () => {
    const w = writer()
    const remember = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.noteIncomingLinkPatch(
      { httpLinkClickBehavior: 'ask', openLinksInAppPreferencePrompted: true },
      { httpLinkClickBehavior: 'ask', openLinksInAppPreferencePrompted: false }
    )
    expect(ops.admitLinkPreferenceOperation(remember, 'admitted')).toBe(false)
    await ops.writeLinkPreference(remember, w)
    expect(w.writes).toEqual([])
  })

  it('shows no notice when the acknowledged state already carries a later change', async () => {
    const op = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.admitLinkPreferenceOperation(op, 'admitted')
    await ops.writeLinkPreference(
      op,
      writer({
        updateSettingsOrThrow: async (_updates, onAcknowledged) =>
          onAcknowledged(accepted({ openLinksInApp: false, httpLinkClickBehavior: 'open' }))
      })
    )
    expect(notices.shown).toEqual([])
  })

  it('dismisses a shown notice when the link fields move away from it', async () => {
    const op = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.admitLinkPreferenceOperation(op, 'admitted')
    await ops.writeLinkPreference(op, writer())
    ops.noteLinkFieldsArrived({ openLinksInApp: true, httpLinkClickBehavior: 'ask' })
    expect(notices.dismissed).toBe(1)
  })
})

describe('Remember after a rejected reply', () => {
  const rejected = (reconciled: LinkPreferenceWriter['reconcile']): LinkPreferenceWriter =>
    writer({
      updateSettingsOrThrow: async () => {
        throw new Error('reply lost')
      },
      reconcile: reconciled
    })

  async function remember(w: LinkPreferenceWriter): Promise<void> {
    const op = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.admitLinkPreferenceOperation(op, 'admitted')
    await expect(ops.writeLinkPreference(op, w)).resolves.toBeUndefined()
  }

  it('reports saved when the follow-up read shows the choice', async () => {
    await remember(rejected(async () => ORCA))
    expect(notices.shown).toEqual([{ kind: 'saved', openLinksInApp: true }])
  })

  it('reports failure when the follow-up read shows another value', async () => {
    await remember(rejected(async () => ({ openLinksInApp: false, httpLinkClickBehavior: 'ask' })))
    expect(notices.shown).toEqual([{ kind: 'failed' }])
  })

  it('reports an unknown outcome when the follow-up read is unavailable or throws', async () => {
    await remember(rejected(async () => null))
    await remember(
      rejected(async () => {
        throw new Error('read failed')
      })
    )
    expect(notices.shown).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
  })

  it('stays silent for Settings writes and for a superseded Remember', async () => {
    const settingsOp = ops.beginLinkPreferenceOperation('settings', {
      httpLinkClickBehavior: 'ask'
    })
    await ops.writeLinkPreference(
      settingsOp,
      rejected(async () => null)
    )
    const op = ops.beginLinkPreferenceOperation('remember', ORCA)
    ops.admitLinkPreferenceOperation(op, 'admitted')
    const pending = ops.writeLinkPreference(
      op,
      rejected(async () => null)
    )
    ops.beginLinkPreferenceOperation('settings', { httpLinkClickBehavior: 'ask' })
    await pending
    expect(notices.shown).toEqual([])
  })
})
