import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { CloudOfflineSnapshot } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { CloudAsleepFilesPanel } from './CloudAsleepFilesPanel'
import {
  markSleepCopyFailed,
  markSleepCopySaving,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'

const DAY = 24 * 60 * 60 * 1000

function serve(snapshot: CloudOfflineSnapshot | null): void {
  Object.defineProperty(window.api, 'orcaCloudOffline', {
    configurable: true,
    value: {
      getSnapshot: async () => snapshot,
      listQueuedPrompts: async () => [],
      onQueuedPromptsChanged: () => () => {}
    }
  })
}

const withChanges = (now: number): CloudOfflineSnapshot => ({
  workspaceId: 'ws',
  asleep: true,
  capturedAt: now - 26_000,
  terminals: [],
  chats: [],
  git: {
    branch: 'ra10-asleep',
    head: '7fd1a60',
    at: now - 26_000,
    changeCount: 2,
    changes: [
      { path: 'README', status: 'modified', area: 'unstaged' },
      { path: 'notes.txt', status: 'untracked', area: 'untracked' }
    ],
    commits: [
      {
        id: '7fd1a60b01f91b3',
        subject: 'Merge pull request #6 from Spaceghost/patch-1',
        author: null,
        at: now - 5362 * DAY
      },
      {
        id: '762941318ee16e5',
        subject: 'New line at end of file.',
        author: null,
        at: now - 5537 * DAY
      },
      { id: '553c2077f0edc3d', subject: 'first commit', author: null, at: now - 5767 * DAY }
    ]
  }
})

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="h-[520px] w-[360px] border-l border-border bg-background">{children}</div>
}

/** Asleep Orca Cloud workspace, Files tab: the files changed at sleep, recent commits, Wake. */
export const changed = defineFixture({
  width: 380,
  setup: () => serve(withChanges(Date.now())),
  render: () => (
    <Frame>
      <CloudAsleepFilesPanel workspaceId="ws" />
    </Frame>
  )
})

/** Nothing saved for it: the neutral note and Wake. */
export const noSnapshot = defineFixture({
  width: 380,
  setup: () => serve(null),
  render: () => (
    <Frame>
      <CloudAsleepFilesPanel workspaceId="ws" />
    </Frame>
  )
})

/** SLEEP-IN-PROGRESS: Sleep just pressed, its copy still saving. Never "Files aren't available" yet. */
export const savingCopy = defineFixture({
  width: 380,
  setup: () => {
    serve(null)
    resetWorktreeSleepViewForTests()
    markSleepCopySaving('ws-saving')
  },
  render: () => (
    <Frame>
      <CloudAsleepFilesPanel workspaceId="ws-saving" />
    </Frame>
  )
})

/** SLEEP-IN-PROGRESS: no copy arrived in time. Says so; Wake. */
export const copySaveFailed = defineFixture({
  width: 380,
  setup: () => {
    serve(null)
    resetWorktreeSleepViewForTests()
    markSleepCopyFailed('ws-failed')
  },
  render: () => (
    <Frame>
      <CloudAsleepFilesPanel workspaceId="ws-failed" />
    </Frame>
  )
})

/** Opening it wakes it: the saved changes stay, with "Waking…" in place of the button. */
export const waking = defineFixture({
  width: 380,
  setup: () => serve(withChanges(Date.now())),
  render: () => (
    <Frame>
      <CloudAsleepFilesPanel workspaceId="ws" waking />
    </Frame>
  )
})
