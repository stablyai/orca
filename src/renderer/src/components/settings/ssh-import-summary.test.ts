import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSyncedSshHostSummary, getSyncedSshServerSummary } from './ssh-import-summary'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('SSH import summary copy', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses complete singular and plural server messages', () => {
    getSyncedSshServerSummary(1)
    getSyncedSshServerSummary(3)

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.settings.SshPane.syncedOneServer',
      'Synced {{count}} server',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.settings.SshPane.syncedManyServers',
      'Synced {{count}} servers',
      { count: 3 }
    )
  })

  it('uses complete singular and plural host messages', () => {
    getSyncedSshHostSummary(1)
    getSyncedSshHostSummary(3)

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedOneHost',
      'Synced {{count}} host.',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedManyHosts',
      'Synced {{count}} hosts.',
      { count: 3 }
    )
  })
})
