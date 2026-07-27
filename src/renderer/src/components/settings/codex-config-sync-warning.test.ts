import { describe, expect, it } from 'vitest'
import { getCodexConfigSyncWarning } from './codex-config-sync-warning'

const systemConfigPath = '/home/user/.codex/config.toml'

describe('getCodexConfigSyncWarning', () => {
  it('stays silent while syncing normally', () => {
    expect(
      getCodexConfigSyncWarning({ state: 'synced', reason: null, systemConfigPath })
    ).toBeNull()
  })

  it('stays silent before the status has loaded', () => {
    expect(getCodexConfigSyncWarning(null)).toBeNull()
    expect(getCodexConfigSyncWarning(undefined)).toBeNull()
  })

  it('surfaces the stall reason so the component can localize it', () => {
    for (const reason of ['missing-source', 'blank-source', 'unreadable-source'] as const) {
      expect(getCodexConfigSyncWarning({ state: 'stalled', reason, systemConfigPath })).toBe(reason)
    }
  })
})
