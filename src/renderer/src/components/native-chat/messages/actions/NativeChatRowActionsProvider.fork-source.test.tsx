// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { NativeChatRowActionsProvider } from './NativeChatRowActionsProvider'
import { NativeChatNoticeRow } from '../notices/NativeChatNoticeRow'
import { ssh } from '../../../sidebar/worktree-list/listing/host-status-test-fixtures'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'

const initial = useAppStore.getInitialState()
const LOCAL_WORKTREE = 'repo-local::/repos/local'
const SSH_WORKTREE = 'repo-ssh::/remote/repo'

const divider: NativeChatTextBlock = {
  type: 'text',
  text: 'Forked from Annotate capabilities',
  presentation: 'forked-from',
  forkedFrom: { sessionId: 'source-chat' }
}

function chatTab(id: string): AppState['unifiedTabsByWorktree'][string][number] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership reads only the chat tab's id and content type.
  return {
    id,
    contentType: 'agent-session',
    entityId: `${id}-session`
  } as AppState['unifiedTabsByWorktree'][string][number]
}

beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({
    terminalStartupRestorationReady: true,
    repos: [
      {
        id: 'repo-local',
        path: '/repos/local',
        displayName: 'Local',
        badgeColor: '#000',
        addedAt: 0
      },
      {
        id: 'repo-ssh',
        path: '/remote/repo',
        displayName: 'Remote',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-ssh'
      }
    ],
    unifiedTabsByWorktree: {
      [LOCAL_WORKTREE]: [chatTab('local-chat')],
      [SSH_WORKTREE]: [chatTab('ssh-chat')]
    },
    sshConnectionStates: new Map([['target-ssh', ssh('disconnected', 'target-ssh')]])
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function renderDivider(tabId: string): void {
  render(
    <NativeChatRowActionsProvider
      pane={{ tabId, agent: 'claude', target: { kind: 'local' } }}
      chat={{ rewind: { surface: undefined } }}
      forks={{ fork: undefined, sideChat: undefined }}
    >
      <NativeChatNoticeRow block={divider} />
    </NativeChatRowActionsProvider>
  )
}

it('lets a fork in a local workspace open its source', () => {
  renderDivider('local-chat')
  expect(
    screen.getByRole('button', { name: 'Forked from Annotate capabilities' })
  ).toBeInTheDocument()
})

it('shows plain words while the SSH workspace is disconnected, and the pill once it connects', () => {
  renderDivider('ssh-chat')
  expect(screen.queryByRole('button')).toBeNull()
  expect(document.body).toHaveTextContent('Forked from Annotate capabilities')
  act(() =>
    useAppStore.setState({
      sshConnectionStates: new Map([['target-ssh', ssh('connected', 'target-ssh')]])
    })
  )
  expect(
    screen.getByRole('button', { name: 'Forked from Annotate capabilities' })
  ).toBeInTheDocument()
})
