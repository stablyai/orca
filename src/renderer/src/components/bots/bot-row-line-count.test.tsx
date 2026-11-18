// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

const listed = vi.hoisted((): { items: number | null } => ({ items: null }))
const NO_ENTRIES: never[] = []

vi.mock('@/store', () => ({ useAppStore: () => NO_ENTRIES }))
vi.mock('@/lib/bot-own-chats', () => ({ useBotOwnChats: () => NO_ENTRIES }))
vi.mock('@/lib/bot-catalog', () => ({
  useBotWaits: () => NO_ENTRIES,
  useListedBotItemsNeedingOwner: () => listed.items
}))
vi.mock('@/components/native-chat/session/status/structured-agent-session-status-hooks', () => ({
  useStructuredAgentSessionsStarting: () => new Set()
}))
vi.mock('./use-bot-worker-statuses', () => ({
  useBotWorkerWorkspaces: () => ({ childWorktrees: NO_ENTRIES }),
  useLiveWorkspaceStatuses: () => NO_ENTRIES
}))
vi.mock('./use-bot-activity', () => ({ useBotActivity: () => null }))
vi.mock('./use-bot-chat-tree', () => ({ useBotChatTree: () => ({ chats: [] }) }))
vi.mock('./bot-connector-entries', () => ({ useBotConnectorEntries: () => [] }))
vi.mock('@/lib/bot-access-requests', () => ({ useAccessRequests: () => [] }))

import { botRowLineText } from '../../../../shared/bots/bot-row-line'
import { useBotRowLine } from './BotRowActivityLine'
import { useBotNeedsYouCount } from './use-bot-now'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the line reads only these fields.
const BOT = { id: 'bot-1', hostId: 'local', paused: false, chatSessionId: null } as Bot
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the line reads only these fields.
const HOME = { id: 'home-1', externalConversations: [] } as unknown as FolderWorkspace

const say = (key: string, values?: Record<string, unknown>) => String(values?.count ?? key)

function Line({ name, count }: { name: string; count?: number }): React.JSX.Element {
  const { line } = useBotRowLine(BOT, HOME, count)
  return (
    <p data-testid={name}>
      {line ? botRowLineText(line, (key, _f, v) => say(key, v), String) : ''}
    </p>
  )
}

/** The panel header: it reads the count (one worker permission, two items) and says it. */
function Header(): React.JSX.Element {
  const count = useBotNeedsYouCount(BOT, { needsYou: 1 })
  return <Line name="header" count={count} />
}

afterEach(() => {
  cleanup()
  listed.items = null
})

it('says one count on the sidebar row, in Cmd+J and in the panel header', () => {
  // Two Needs you items, as the host counted them.
  listed.items = 2
  const { rerender } = render(
    <>
      <Header />
      <Line name="row" />
      <Line name="palette" />
    </>
  )
  expect(['header', 'row', 'palette'].map((id) => screen.getByTestId(id).textContent)).toEqual([
    '3',
    '3',
    '3'
  ])

  // The panel closes: the row counts its own asks plus the items its host counted.
  rerender(
    <>
      <Line name="row" />
      <Line name="palette" />
    </>
  )
  expect(screen.getByTestId('row').textContent).toBe('2')
  expect(screen.getByTestId('palette').textContent).toBe('2')
})
