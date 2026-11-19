import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'
import { UpdateCard } from './UpdateCard'

export const available = defineFixture({
  width: 1280,
  store: {
    updateStatus: { state: 'available', version: '1.4.246', changelog: null },
    updateChangelog: null,
    updateCardCollapsed: false,
    dismissedUpdateVersion: null,
    updateReassuranceSeen: true
  },
  render: () => (
    <div className="h-[868px]">
      <NotificationCardStack>
        <UpdateCard />
      </NotificationCardStack>
    </div>
  )
})

const RELEASE_NOTES = `## Faster chat switching, lower memory use & git blame

Keep more conversations open with less memory on macOS and Linux.

- ⚡ **Work across many chats:** hidden chat views pause their updates.
- 🧭 **Line history in the editor:** see who changed a line and when.
- 🧹 **Workspace cleanup:** optionally delete chats from deleted workspaces.`

export const availableWithReleaseHistory = defineFixture({
  width: 1280,
  store: {
    updateStatus: {
      state: 'available',
      version: '1.4.263',
      changelog: null,
      releaseHistory: {
        installedVersion: '1.4.258',
        newerReleaseCount: 4,
        releases: ['1.4.263', '1.4.262', '1.4.261', '1.4.259'].map((version) => ({
          version,
          publishedAt: '2026-11-18T11:02:11Z',
          notes: RELEASE_NOTES,
          releaseUrl: `https://github.com/stablyai/orca/releases/tag/v${version}`
        }))
      }
    },
    updateChangelog: null,
    updateCardCollapsed: false,
    dismissedUpdateVersion: null,
    updateReassuranceSeen: true
  },
  render: () => (
    <div className="h-[868px]">
      <NotificationCardStack>
        <UpdateCard />
      </NotificationCardStack>
    </div>
  )
})
