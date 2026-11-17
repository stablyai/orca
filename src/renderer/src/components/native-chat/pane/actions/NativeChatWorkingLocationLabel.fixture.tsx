import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatWorkingLocationLabel } from './NativeChatWorkingLocationLabel'

const HEADER_STYLE: React.CSSProperties & Record<'--orca-pane-title-bg', string> = {
  position: 'relative',
  '--orca-pane-title-bg': 'var(--chat-canvas)'
}

// The focused chat header reveals pane-title actions, as NativeChatPaneHeader does.
function Header({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="pane-title-bar flex h-8 items-center pr-2"
      data-active-pane=""
      data-pane-title-surface={
        document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      }
      style={HEADER_STYLE}
    >
      {children}
    </div>
  )
}

export const worktree = defineFixture({
  width: 560,
  render: () => (
    <Header>
      <NativeChatWorkingLocationLabel
        location={{
          kind: 'worktree',
          worktreeId: 'fixture-worktree',
          repoId: 'fixture-repo',
          hostId: undefined,
          path: '/repo/.claude/worktrees/fix-login',
          displayName: 'fix-login',
          branch: 'worktree-fix-login',
          hidden: true
        }}
        opening={false}
        onOpen={() => {}}
      />
    </Header>
  )
})

export const folder = defineFixture({
  width: 560,
  render: () => (
    <Header>
      <NativeChatWorkingLocationLabel
        location={{ kind: 'folder', path: '/tmp/scratch-notes', displayName: 'scratch-notes' }}
        opening={false}
        onOpen={() => {}}
      />
    </Header>
  )
})
