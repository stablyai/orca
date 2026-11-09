import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { CloudWorkspaceOfflineView } from './CloudWorkspaceOfflineView'

const NOW = 1_794_230_000_000
const MIN = 60_000

const snapshot: CloudOfflineSnapshot = {
  workspaceId: 'w1',
  asleep: true,
  capturedAt: NOW - 14 * MIN,
  git: {
    branch: 'feature/offline-cache',
    head: '3f95655684912ab',
    changeCount: 3,
    changes: [
      {
        path: 'src/main/hosted-sandbox/cloud-offline-cache.ts',
        status: 'added',
        area: 'untracked'
      },
      {
        path: 'src/main/ipc/runtime-environments/connectivity.ts',
        status: 'modified',
        area: 'unstaged'
      },
      { path: 'README.md', status: 'modified', area: 'staged' }
    ],
    commits: [
      {
        id: '3f956556849',
        subject: 'Cache read-only answers for sleeping VMs',
        author: 'Ada',
        at: NOW - 40 * MIN
      },
      {
        id: '41b60ea4b10',
        subject: 'Parallel boot prep and warmed compile cache',
        author: 'Ada',
        at: NOW - 3 * 60 * MIN
      }
    ],
    at: NOW - 14 * MIN
  },
  terminals: [
    {
      handle: 'term-1',
      title: 'pnpm dev',
      lines: [
        '> web@0.0.0 dev',
        '> vite',
        '',
        '  VITE v6.2.0  ready in 412 ms',
        '',
        '  ➜  Local:   http://localhost:5173/'
      ],
      at: NOW - 14 * MIN
    }
  ],
  chats: [
    {
      sessionId: 's1',
      at: NOW - 14 * MIN,
      messages: [
        {
          itemId: 'm1',
          role: 'user',
          text: 'Add a client-side cache so a sleeping workspace is readable.',
          at: NOW - 30 * MIN
        },
        {
          itemId: 'm2',
          role: 'assistant',
          text: 'Done. Read-only answers (chat history, terminal output, git status) are kept per workspace on this computer and served while the VM sleeps. Tests pass.',
          at: NOW - 15 * MIN
        }
      ]
    }
  ]
}

const queued: CloudQueuedPrompt[] = [
  {
    id: 'q1',
    workspaceId: 'w1',
    sessionId: 's1',
    text: 'Now open a PR for it.',
    state: 'queued',
    createdAt: NOW,
    updatedAt: NOW
  }
]

const noop = (): void => {}
const yes = async (): Promise<boolean> => true

function frame(children: React.ReactNode): React.JSX.Element {
  return <div className="flex h-[560px] justify-center bg-background">{children}</div>
}

export const asleepWithChat = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={queued}
        waking={false}
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const wakingAfterSend = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={[{ ...queued[0]!, state: 'sending' }]}
        waking
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const terminalsTab = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{ ...snapshot, chats: [] }}
        queued={[]}
        waking={false}
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const changesTab = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{ ...snapshot, chats: [], terminals: [] }}
        queued={[]}
        waking={false}
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const nothingCachedYet = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{
          workspaceId: 'w1',
          asleep: true,
          capturedAt: null,
          git: null,
          terminals: [],
          chats: []
        }}
        queued={[]}
        waking={false}
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const deliveryFailed = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={[{ ...queued[0]!, state: 'failed', error: 'The agent session was closed.' }]}
        waking={false}
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})
