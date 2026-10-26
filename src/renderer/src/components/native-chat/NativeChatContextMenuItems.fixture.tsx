import { useRef } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { buildHttpLinkActions } from '@/lib/http-link-destinations'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatContextMenuTarget } from './native-chat-context-menu-target'
import {
  NativeChatContextMenuTargetItems,
  NativeChatFindMenuItem
} from './NativeChatContextMenuItems'

const LINK_URL = 'https://github.com/stablyai/orca/pull/1234'

// Default routing (Link Routing off): system browser primary, Orca Browser alternate.
const linkTarget: NativeChatContextMenuTarget = {
  quoteText: null,
  link: {
    destination: LINK_URL,
    kind: 'url',
    ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {})
  },
  codeText: null,
  messageText: `Opened ${LINK_URL} for review.`,
  rewindItemId: null
}

// Right-clicked on a link in a chat message.
function NativeChatLinkContextMenu(): React.JSX.Element {
  const composerRef = useRef<NativeChatComposerHandle | null>(null)
  return (
    <div className="relative h-[220px] text-sm">
      <span>Opened </span>
      <span className="text-primary underline">{LINK_URL}</span>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: 120, top: 20 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" sideOffset={0} align="start">
          <NativeChatContextMenuTargetItems
            target={linkTarget}
            composerRef={composerRef}
            rewind={undefined}
            linkContext={{
              worktreeId: 'fixture-worktree',
              worktreePath: '/repo',
              runtimeEnvironmentId: null
            }}
          />
          <DropdownMenuSeparator />
          <NativeChatFindMenuItem onSelect={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const linkMenu = defineFixture({
  width: 420,
  store: {
    // A local repo owns the workspace; an unknown owner would hide the "Open in" submenu.
    repos: [
      {
        id: 'fixture-worktree',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#737373',
        addedAt: 0
      }
    ],
    installedBrowsers: [
      { id: 'com.google.Chrome', name: 'Google Chrome' },
      { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
      { id: 'com.apple.Safari', name: 'Safari' }
    ]
  },
  render: () => <NativeChatLinkContextMenu />,
  // Expand "Open in" so the installed browsers are captured.
  interact: () => {
    const openIn = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    ).find((trigger) => trigger.textContent === 'Open in')
    openIn?.focus()
    openIn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
