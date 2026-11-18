import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import { NativeChatOwnerWorktreeContext } from '../../pane/ownership/native-chat-owner-worktree-context'
import { nativeChatTurnDiffs } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type {
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

const messages: NativeChatMessage[] = [
  {
    id: 'user',
    role: 'user',
    source: 'transcript',
    timestamp: 0,
    blocks: [{ type: 'text', text: 'Update the greeting and mark the feature ready.' }]
  },
  {
    id: 'edits',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      {
        type: 'tool-call',
        name: 'Bash',
        state: 'completed',
        input: { command: 'inspect sources' }
      },
      { type: 'tool-result', output: 'Source files inspected.' },
      {
        type: 'tool-call',
        name: 'Edit',
        state: 'completed',
        input: {
          file_path: '/Users/alice/orca/workspaces/orca/feature-x/src/components/greeting.ts',
          old_string: 'return "Hello"',
          new_string: 'return `Hello, ${name}`'
        }
      },
      { type: 'tool-result', output: 'The file was updated successfully.' },
      { type: 'tool-call', name: 'Diff', input: { path: 'src/components/status.ts' } },
      {
        type: 'tool-result',
        output: '@@ -1 +1 @@\n-export const ready = false\n+export const ready = true'
      }
    ]
  },
  {
    id: 'answer',
    role: 'assistant',
    source: 'transcript',
    timestamp: 2,
    blocks: [
      { type: 'text', text: 'The greeting now includes the name, and the feature is ready.' }
    ]
  }
]
const diff = nativeChatTurnDiffs(
  messages,
  messages.map(() => 'turn')
).get('turn')!
export const settled = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />
})
export const opened = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})
export const hideShown = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />,
  // Keyboard focus shows the Hide button, as card hover does, without a pointer in the headless shot.
  interact: (frame) => {
    frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    frame.querySelector<HTMLButtonElement>('button[aria-label="Hide"]')?.focus()
  }
})

const WORKTREE_ID = 'fixture-wt'
const WORKTREE_PATH = '/Users/alice/orca/workspaces/orca/feature-x'
const STATUS_HEAD = 'aaa111'
const fixtureWorktree = makeWorktree({
  id: WORKTREE_ID,
  repoId: 'fixture-repo',
  path: WORKTREE_PATH,
  head: STATUS_HEAD
})
const greetingEntry: GitStatusEntry = {
  path: '/Users/alice/orca/workspaces/orca/feature-x/src/components/greeting.ts',
  status: 'modified',
  area: 'unstaged'
}
const statusEntry: GitStatusEntry = {
  path: 'src/components/status.ts',
  status: 'modified',
  area: 'unstaged'
}
const unpushed: GitUpstreamStatus = {
  hasUpstream: true,
  upstreamName: 'origin/feature-x',
  ahead: 2,
  behind: 0,
  head: STATUS_HEAD
}
const pushed: GitUpstreamStatus = {
  hasUpstream: true,
  upstreamName: 'origin/feature-x',
  ahead: 0,
  behind: 0,
  head: STATUS_HEAD
}

function CardInWorktree() {
  return (
    <NativeChatOwnerWorktreeContext.Provider value={WORKTREE_ID}>
      <NativeChatTurnDiffRollup diff={diff} />
    </NativeChatOwnerWorktreeContext.Provider>
  )
}

function gitStore(entries: GitStatusEntry[], upstream: GitUpstreamStatus) {
  return {
    worktreesByRepo: { 'fixture-repo': [fixtureWorktree] },
    gitStatusByWorktree: { [WORKTREE_ID]: entries },
    gitStatusHeadByWorktree: { [WORKTREE_ID]: STATUS_HEAD },
    remoteStatusesByWorktree: { [WORKTREE_ID]: upstream }
  }
}

export const uncommitted = defineFixture({
  width: 560,
  store: gitStore([greetingEntry, statusEntry], unpushed),
  render: () => <CardInWorktree />
})
export const mixedUncommitted = defineFixture({
  width: 560,
  store: gitStore([statusEntry], unpushed),
  render: () => <CardInWorktree />
})
export const diverged = defineFixture({
  width: 560,
  store: gitStore([{ ...greetingEntry, added: 2, removed: 0 }, statusEntry], unpushed),
  render: () => <CardInWorktree />
})
export const committedUnpushed = defineFixture({
  width: 560,
  store: gitStore([], unpushed),
  render: () => <CardInWorktree />
})
export const committedPushed = defineFixture({
  width: 560,
  store: gitStore([], pushed),
  render: () => <CardInWorktree />
})

const session: NativeChatLiveSession = {
  messages,
  agent: 'claude',
  sessionId: 'fixture',
  status: 'ready',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'applied'
}
function Transcript({ working = false }: { working?: boolean }) {
  return (
    <div className="flex h-[600px] flex-col">
      <NativeChatMessageList
        session={session}
        isWorking={working}
        expandSignal={false}
        settledTurns={working ? undefined : new Map([['user', { startedAt: 0, workedSeconds: 2 }]])}
      />
    </div>
  )
}
export const completedTranscript = defineFixture({ width: 560, render: () => <Transcript /> })
export const completedTranscriptOpened = defineFixture({
  width: 560,
  render: () => <Transcript />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[title$="greeting.ts"]')?.click()
  }
})
export const liveTranscript = defineFixture({ width: 560, render: () => <Transcript working /> })
