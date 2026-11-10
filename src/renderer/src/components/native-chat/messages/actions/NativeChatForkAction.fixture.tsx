import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatAgentControls } from './NativeChatAgentControls'
import { NativeChatUserForkAction } from './NativeChatUserForkAction'
import { NativeChatForkContext } from './native-chat-fork-context'
import type { NativeChatForkSurface } from './use-native-chat-fork'
import { NativeChatForkAction } from './NativeChatForkAction'
import { NativeChatWorktreeForkDialogHost } from './NativeChatWorktreeForkDialog'
import type { NativeChatForkRowAction } from './use-native-chat-fork'
import type { Worktree } from '../../../../../../shared/worktree/types'

const SOURCE_ID = 'repo::/home/me/work/orca/login'

const worktree = (path: string, branch: string, displayName: string): Worktree =>
  ({
    id: `repo::${path}`,
    repoId: 'repo',
    path,
    branch: `refs/heads/${branch}`,
    head: 'abc123',
    displayName,
    isBare: false,
    isMainWorktree: false
  }) as unknown as Worktree

const store = {
  repos: [{ id: 'repo', kind: 'git', path: '/home/me/work/orca', displayName: 'orca' }],
  worktreesByRepo: {
    repo: [
      worktree('/home/me/work/orca/login', 'me/login', 'Login'),
      worktree('/home/me/work/orca/login-fork', 'me/login-fork', 'Fork of Login')
    ]
  }
} as never

const fork: NativeChatForkRowAction = {
  support: { kind: 'unknown' },
  pendingItemId: null,
  request: async () => undefined,
  openWorktreeFork: () => {},
  forkPointBefore: () => 'reply-0'
}
const ready: NativeChatForkRowAction = {
  ...fork,
  support: { kind: 'known', fork: 'checkpoint' } as NativeChatForkRowAction['support']
}

/** The controls under a finished response: the fork icon sits beside copy. */
export const responseRow = defineFixture({
  width: 420,
  render: () => (
    <div className="bg-background p-6">
      <p className="mb-2 text-sm">Done. The login form now validates the email on blur.</p>
      <NativeChatAgentControls
        markdown="Done."
        timestamp={Date.now()}
        onScrollToTop={() => {}}
        action={<NativeChatForkAction itemId="reply-1" fork={ready} />}
      />
    </div>
  )
})

/** Clicking the fork icon: every fork in one menu. */
export const menuOpen = defineFixture({
  ...responseRow,
  render: () => (
    <div className="bg-background p-6 pb-40">
      <p className="mb-2 text-sm">Done. The login form now validates the email on blur.</p>
      <NativeChatAgentControls
        markdown="Done."
        timestamp={Date.now()}
        onScrollToTop={() => {}}
        action={<NativeChatForkAction itemId="reply-1" fork={ready} />}
      />
    </div>
  ),
  interact: (frame) => {
    const button = frame.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork from this response"]'
    )
    button?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})

const dialog = (mode: 'worktree' | 'subagent') =>
  defineFixture({
    width: 560,
    store,
    render: () => (
      <NativeChatWorktreeForkDialogHost
        dialog={{ throughItemId: 'reply-1', mode, close: () => {} }}
        sourceWorktreeId={SOURCE_ID}
        agent="claude"
        request={fork.request}
        source={{ target: { kind: 'local' }, sessionId: 'claude_source', label: 'Login chat' }}
      />
    )
  })

/** "Into a new worktree…": name defaults to the next free Fork N, with folder and branch. */
export const worktreeDialog = dialog('worktree')

/** "As a background subagent…": the same, plus the task it works on. */
export const subagentDialog = dialog('subagent')

/** Your own message: copy, then Fork from here, which opens the chat up to it with it as a draft. */
export const userMessageMenu = defineFixture({
  width: 420,
  render: () => (
    <NativeChatForkContext.Provider value={ready as unknown as NativeChatForkSurface}>
      <div className="flex flex-col items-end gap-1 bg-background p-6 pb-32">
        <div className="rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-sm">
          Validate the email on blur
        </div>
        <NativeChatUserForkAction itemId="message-1" text="Validate the email on blur" />
      </div>
    </NativeChatForkContext.Provider>
  ),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="Fork from here"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})
