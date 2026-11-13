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
          text: 'Done. Read-only answers (chat history, terminal output, git status) are kept per workspace on this computer and served while the sandbox sleeps. Tests pass.',
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
        workspaceName="fix-auth-redirect"
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

export const deliveringAfterWake = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={[{ ...queued[0]!, state: 'sending' }]}
        workspaceName="fix-auth-redirect"
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
        workspaceName="fix-auth-redirect"
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
        workspaceName="fix-auth-redirect"
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
        workspaceName="fix-auth-redirect"
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
        workspaceName="fix-auth-redirect"
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

/** Merged with the copy the workspace saved when it went to sleep: PR, line counts, "As of". */
export const withCloudSnapshot = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{
          ...snapshot,
          capturedAt: NOW - 6 * MIN,
          source: 'mixed',
          pr: {
            number: 412,
            title: 'Keep a read-only copy of sleeping workspaces',
            state: 'open',
            url: 'https://github.com/acme/web/pull/412',
            checksStatus: 'success',
            checksSummary: '12/12 passed'
          },
          git: {
            ...snapshot.git!,
            at: NOW - 6 * MIN,
            added: 182,
            removed: 41,
            changes: snapshot.git!.changes.map((change, index) => ({
              ...change,
              added: [120, 54, 8][index] ?? 0,
              removed: [0, 37, 4][index] ?? 0
            }))
          }
        }}
        queued={[]}
        workspaceName="fix-auth-redirect"
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

/** Sleep chosen with an earlier copy: the saving state shows until the new copy is in. */
export const goingToSleepWithEarlierCopy = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={[]}
        workspaceName="fix-auth-redirect"
        now={NOW}
        goingToSleep
        viewOnly
        onKeepAwake={noop}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

/** SLEEP-IN-PROGRESS: the sleep returned but its copy isn't read back yet. Never "nothing saved". */
export const savingCopyAfterSleep = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{ ...snapshot, capturedAt: null, terminals: [], chats: [], git: null }}
        queued={[]}
        workspaceName="fix-auth-redirect"
        now={NOW}
        viewOnly
        copySave="saving"
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

/** SLEEP-IN-PROGRESS: no copy arrived in time. Says so; Wake is the one action. */
export const copySaveFailed = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{ ...snapshot, capturedAt: null, terminals: [], chats: [], git: null }}
        queued={[]}
        workspaceName="fix-auth-redirect"
        now={NOW}
        viewOnly
        copySave="failed"
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})

const PROMPT = 'ubuntu@w2slot:~/orca/workspaces/Hello-World/w2slot$'

/** A terminal respawned by wakes: each boot's prompt on its own line, no blank rows above. */
export const terminalAfterWakes = defineFixture({
  width: 900,
  render: () =>
    frame(
      <CloudWorkspaceOfflineView
        snapshot={{
          ...snapshot,
          chats: [],
          terminals: [
            {
              handle: 'boot-3',
              title: null,
              lines: [...Array<string>(14).fill(''), `${PROMPT} ${PROMPT} ${PROMPT} `],
              at: NOW - 2 * MIN
            }
          ]
        }}
        queued={[]}
        workspaceName="w2slot"
        now={NOW}
        onWake={noop}
        onQueue={yes}
        onCancel={noop}
        onEdit={yes}
      />
    )
})
