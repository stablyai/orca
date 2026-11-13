import { useRef } from 'react'
import { defineFixture } from '@/component-fixtures/component-fixture'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from '../../pane/actions/use-native-chat-context-menu'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

const context = {
  worktreeId: 'folder:chat',
  worktreePath: '/Users/demo/project',
  runtimeEnvironmentId: null,
  sourceTabId: 'chat'
}

function FileLinks(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    context,
    rootRef,
    { sessionId: 'session', isVisible: true }
  )
  const { onContextMenuCapture, menu } = useNativeChatContextMenu({
    rootRef,
    composerRef,
    fileLinkContext: context,
    actions: { ...emptyNativeChatContextMenuActions, onPaste: () => {} },
    showTerminalPaneActions: false
  })
  return (
    <div
      ref={rootRef}
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
      onContextMenuCapture={onContextMenuCapture}
    >
      <CommentMarkdown
        variant="document"
        content={
          'Updated the global configuration at `~/.codex/AGENTS.md`.\n\n' +
          'The section added to `AGENTS.md` tells the agent how to search code.\n\n' +
          'Explicit: [AGENTS.md](AGENTS.md), `./AGENTS.md`.\n\n' +
          'Generated: `report.html`.'
        }
        fileLinkExists={() => true}
        onLinkClick={onLinkClick}
      />
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
      {menu}
    </div>
  )
}

function fileLinkFixture(index: number, width = 640, rightClick = false) {
  return defineFixture({
    width,
    store: {
      activeWorktreeId: 'folder:other',
      folderWorkspaces: [
        {
          id: 'chat',
          projectGroupId: 'group',
          name: 'Chat workspace',
          folderPath: context.worktreePath,
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    render: () => <FileLinks />,
    interact: (frame) => {
      const anchor = frame.querySelectorAll('a')[index]
      if (!anchor) {
        throw new Error('Missing fixture file link')
      }
      if (rightClick) {
        const bounds = anchor.getBoundingClientRect()
        anchor.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: bounds.left,
            clientY: bounds.bottom
          })
        )
      } else {
        anchor.click()
      }
    }
  })
}

export const inferred = fileLinkFixture(1)
export const explicit = fileLinkFixture(2)
export const html = fileLinkFixture(4)
export const narrow = fileLinkFixture(1, 360)
export const contextMenu = fileLinkFixture(1, 640, true)
