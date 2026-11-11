import type { ToknSyncStatus } from '../../../../shared/tokn-sync-status'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ToknPublishCard } from './ToknPublishCard'

const DISCONNECTED: ToknSyncStatus = {
  connected: false,
  connecting: false,
  syncing: false,
  handle: null,
  profileUrl: null,
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncErrorDetail: null,
  lastSyncAccepted: null,
  lastSyncRejected: null,
  tracking: { claude: true, codex: true }
}

const CONNECTED: ToknSyncStatus = {
  ...DISCONNECTED,
  connected: true,
  handle: 'ada',
  profileUrl: 'https://toknhq.com/profile/ada',
  lastSyncAt: Date.parse('2026-11-11T14:05:00'),
  lastSyncAccepted: 124,
  lastSyncRejected: 0
}

function stubTokn(status: ToknSyncStatus): () => void {
  return () => {
    window.api.tokn = {
      getStatus: async () => status,
      connect: async () => ({ outcome: 'cancelled', status }),
      cancelConnect: async () => status,
      disconnect: async () => DISCONNECTED,
      syncNow: async () => status,
      previewUpload: async () => ({
        endpoint: 'https://toknhq.com/api/cli/sync',
        body: {
          rows: [
            {
              day: '2026-11-10',
              tool: 'claude-code',
              model: 'claude-opus-5-5',
              requests: 412,
              input: 980,
              output: 402113,
              cacheWrite5m: 0,
              cacheWrite1h: 2766180,
              cacheRead: 188248790,
              costUsd: 141.62,
              fast: false
            }
          ],
          timezone: 'America/Los_Angeles',
          scannedAt: '2026-11-11T22:05:00.000Z',
          cliVersion: '1.4.214'
        }
      })
    }
  }
}

export const notConnectedTrackingOff = defineFixture({
  width: 640,
  setup: stubTokn({ ...DISCONNECTED, tracking: { claude: false, codex: false } }),
  render: () => <ToknPublishCard />
})

export const connected = defineFixture({
  width: 640,
  setup: stubTokn(CONNECTED),
  render: () => <ToknPublishCard />
})

export const connectedWithError = defineFixture({
  width: 640,
  setup: stubTokn({ ...CONNECTED, lastSyncError: 'network' }),
  render: () => <ToknPublishCard />
})

export const previewOpen = defineFixture({
  width: 640,
  setup: stubTokn(CONNECTED),
  render: () => <ToknPublishCard />,
  interact: async (frame) => {
    const trigger = [...frame.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Preview upload')
    )
    trigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
