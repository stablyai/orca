import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatWorkingLocationLabel } from './NativeChatWorkingLocationLabel'
import type { NativeChatWorkingLocation } from './native-chat-working-location'

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

const WORKTREE: NativeChatWorkingLocation = {
  kind: 'worktree',
  worktreeId: 'fixture-worktree',
  repoId: 'fixture-repo',
  hostId: undefined,
  path: '/repo/.claude/worktrees/fix-login',
  displayName: 'fix-login',
  branch: 'worktree-fix-login',
  hidden: true
}

export const worktree = defineFixture({
  width: 560,
  render: () => (
    <Header>
      <NativeChatWorkingLocationLabel location={WORKTREE} opening={false} onOpen={() => {}} />
    </Header>
  )
})

// Keyboard focus opens the tooltip that carries the branch and path.
export const worktreeTooltip = defineFixture({
  width: 560,
  render: worktree.render,
  interact: async (frame) => {
    // Tooltips open on focus only after keyboard input, as when tabbing to the label.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    frame.querySelector<HTMLElement>('[data-native-chat-working-location] [tabindex="0"]')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
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
