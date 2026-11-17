import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatLinkProviders } from '../links/actions/NativeChatLinkProviders'
import { NativeChatTurnDiffRollup } from '../tools/diffs/NativeChatTurnDiffRollup'
import { NativeChatTextAttachments } from '../media/text/NativeChatTextAttachments'
import { nativeChatTurnDiffs } from '../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatFileOpener } from '../links/actions/use-native-chat-file-link-click'
import type { AppState } from '@/store/types'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../../../../shared/agent-session/agent-session-attachments'

function edit(id: string, path: string, patch: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'tool-call', name: 'Diff', input: { path } },
      { type: 'tool-result', output: patch }
    ]
  }
}

const messages = [
  edit('a', 'src/site/index.html', '@@ -1,2 +1,4 @@\n-a\n+b\n+c\n+d'),
  edit('b', 'docs/notes.md', '@@ -1 +1,5 @@\n+1\n+2\n+3\n+4\n+5'),
  edit('c', 'src/app.ts', '@@ -1 +1 @@\n-old\n+new'),
  edit(
    'd',
    'obsolete.txt',
    `diff --git a/obsolete.txt b/obsolete.txt\ndeleted file mode 100644\n--- a/obsolete.txt\n+++ /dev/null\n@@ -1,12 +0,0 @@\n${'-x\n'.repeat(12)}`
  )
]
const turn = nativeChatTurnDiffs(
  messages,
  messages.map(() => 'turn')
).get('turn')!

const opener: NativeChatFileOpener = {
  worktreeId: 'wt-site',
  resolvePath: (href) => `/repo/${decodeURIComponent(href.split(':').pop() ?? '')}`,
  destinationFor: () => 'editor',
  open: () => {}
}

// A local workspace, so the HTML row offers the Orca Browser.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: seeds only the repo/worktree fields the browser-availability predicate reads.
const localWorkspace = {
  repos: [{ id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '#888', addedAt: 0 }],
  worktreesByRepo: {
    repo: [
      {
        id: 'wt-site',
        repoId: 'repo',
        path: '/repo',
        head: 'abc',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true,
        displayName: 'main'
      }
    ]
  }
} as unknown as Partial<AppState>

function Chat({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <NativeChatLinkProviders links={{ onLinkClick: undefined, openFile: opener }}>
      <div
        className="native-chat-appearance bg-chat-canvas p-3"
        style={nativeChatAppearanceStyle({})}
      >
        {children}
      </div>
    </NativeChatLinkProviders>
  )
}

export const turnSummary = defineFixture({
  width: 360,
  store: localWorkspace,
  render: () => (
    <Chat>
      <NativeChatTurnDiffRollup diff={turn} />
    </Chat>
  )
})

export const turnSummaryWide = defineFixture({ ...turnSummary, width: 640 })

const ATTACHMENTS = `/tmp/${AGENT_SESSION_ATTACHMENTS_DIR_NAME}/0b6f2c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f`

export const attachments = defineFixture({
  width: 360,
  render: () => (
    <Chat>
      <div className="flex flex-col items-end gap-2">
        <NativeChatTextAttachments
          content={`Please review @${ATTACHMENTS}/orca-perf-survey-prompt.md @${ATTACHMENTS}/orca-paste-1.txt`}
          structured
          renderText={() => <p className="text-sm text-chat-foreground">Please review</p>}
        />
      </div>
    </Chat>
  )
})
