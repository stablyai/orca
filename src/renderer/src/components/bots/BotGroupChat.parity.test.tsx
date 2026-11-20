// @vitest-environment happy-dom
import { forwardRef, useContext, useImperativeHandle, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as HttpLinkRoutingModule from '@/lib/browser/navigation/http-link-routing'
import type * as BotHostsModule from '@/lib/bot-hosts'
import type * as WorkspaceRecordSelectorsModule from '@/store/workspaces/catalog/workspace-record-fields'
import type * as TerminalFileOpenRoutingModule from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import type { NativeChatStructuredComposerTransport } from '../native-chat/composer/submit/native-chat-structured-composer-transport'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotGroupChat } from './BotGroupChat'
import { NativeChatSessionHistoryScopeContext } from '../native-chat/native-chat-session-history-scope'

type ComposerSeen = { scope: string; worktreeId: string | null | undefined }
const mocks = vi.hoisted(() => {
  const typed: string[] = []
  const seen: {
    composer: ComposerSeen | null
    transport: NativeChatStructuredComposerTransport | undefined
  } = { composer: null, transport: undefined }
  return {
    openHttpLink: vi.fn(),
    openDetectedFilePath: vi.fn(),
    callBotRpc: vi.fn(),
    typed,
    focused: 0,
    seen
  }
})

const fixtures = vi.hoisted(() => {
  const group: {
    id: string
    hostId: string
    name: string
    revision: number
    folderWorkspaceId: string
    members: { botId: string; sessionId: string }[]
  } = {
    id: 'group-1',
    hostId: 'local',
    name: 'Room',
    revision: 1,
    folderWorkspaceId: 'room-home',
    members: []
  }
  const messages: {
    id: string
    author: { kind: 'owner' }
    text: string
    images?: { path: string; name: string; bytes: number }[]
    createdAt: number
    turns: unknown[]
  }[] = [
    {
      id: 'message-1',
      author: { kind: 'owner' },
      text: 'See https://example.com/docs for details',
      createdAt: 1,
      turns: [
        {
          operationId: 'operation-1',
          botId: 'bot-a',
          botName: 'A',
          avatar: null,
          agent: 'claude',
          sessionId: 'session-a',
          frozenItems: [
            {
              itemId: 'member-report',
              revision: 1,
              sequence: 1,
              observedAt: 1,
              turnScope: { kind: 'turn', turnItemId: 'turn' },
              body: {
                kind: 'message',
                role: 'assistant',
                blocks: [
                  {
                    type: 'text',
                    text: 'Wrote [the report](report.html). ![Chart](chart.png)'
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
  return {
    folders: [
      { id: 'room-home', folderPath: '/rooms/room-1' },
      { id: 'bot-a-home', folderPath: '/bots/a' }
    ],
    groups: [group],
    bots: [{ id: 'bot-a', name: 'A', agent: 'claude', folderWorkspaceId: 'bot-a-home' }],
    transcript: {
      data: {
        group,
        messages,
        hasEarlier: false
      },
      apply: () => {},
      loadEarlier: () => {}
    }
  }
})

vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHostsModule>()),
  callBotRpc: mocks.callBotRpc
}))
vi.mock('@/lib/browser/navigation/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRoutingModule>()),
  openHttpLink: mocks.openHttpLink
}))
vi.mock('../native-chat/links/actions/native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' }),
  canNativeChatOpenOwnedBrowser: () => true
}))
vi.mock(
  '@/components/terminal-pane/links/files/terminal-file-open-routing',
  async (importOriginal) => ({
    ...(await importOriginal<typeof TerminalFileOpenRoutingModule>()),
    openDetectedFilePath: mocks.openDetectedFilePath
  })
)
vi.mock('@/store/workspaces/catalog/workspace-record-fields', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceRecordSelectorsModule>()),
  selectFolderWorkspaces: () => fixtures.folders
}))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => fixtures.bots, useBotsEnabled: () => true }))
vi.mock('@/lib/bot-group-list', () => ({ useBotGroups: () => fixtures.groups }))
vi.mock('./use-bot-group-transcript', () => ({
  useBotGroupTranscript: () => fixtures.transcript
}))
vi.mock('./use-bot-group-room-read', () => ({ useBotGroupRoomRead: () => {} }))
vi.mock('./use-bot-group-composer-room', () => ({
  useBotGroupComposerRoom: () => ({ room: undefined, mentionNames: [], recipientId: null })
}))
vi.mock('./BotGroupSessionReader', () => ({ BotGroupSessionReader: () => null }))
vi.mock('./BotGroupApprovalDock', () => ({ BotGroupApprovalDock: () => null }))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="link-actions">{children}</div>
  )
}))
// The room's composer is the shared one; only its handle matters to the room surface.
vi.mock('../native-chat/composer/NativeChatComposer', () => ({
  NativeChatComposer: forwardRef<
    NativeChatComposerHandle,
    { structuredTransport?: NativeChatStructuredComposerTransport }
  >(function Composer(props, ref) {
    mocks.seen.composer = {
      scope: useContext(NativeChatSessionHistoryScopeContext),
      worktreeId: props.structuredTransport?.worktreeId
    }
    mocks.seen.transport = props.structuredTransport
    useImperativeHandle(ref, () => ({
      insertAgentReferences: () => false,
      focus: () => {
        mocks.focused++
        return true
      },
      insertTypedText: (text: string) => {
        mocks.typed.push(text)
        return true
      },
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }))
    return <textarea aria-label="Message" />
  })
}))

beforeEach(() => {
  mocks.openHttpLink.mockReset()
  mocks.openDetectedFilePath.mockReset()
  mocks.callBotRpc.mockReset()
  mocks.typed.length = 0
  mocks.focused = 0
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoom() {
  return render(
    <TooltipProvider>
      <BotGroupChat roomId="group-1" tabId="room-tab" isVisible isFocusedGroup />
    </TooltipProvider>
  )
}

it('a link in a group message opens the same destination popover as a chat tab', () => {
  renderRoom()
  fireEvent.click(screen.getByRole('link', { name: 'https://example.com/docs' }))

  const popover = screen.getByTestId('link-actions')
  expect(popover.textContent).toContain('https://example.com/docs')
  expect(popover.textContent).toMatch(/System Browser/i)
  expect(mocks.openHttpLink).not.toHaveBeenCalled()
})

it('typing while the transcript has focus lands in the room composer', () => {
  renderRoom()
  const transcript = screen.getByRole('region', { name: 'Conversation' })
  act(() => transcript.focus())
  fireEvent.keyDown(transcript, { key: 'h' })

  expect(mocks.typed).toEqual(['h'])
})

it('opens Find from the transcript menu and matches text in a room message', async () => {
  const view = renderRoom()
  const transcript = view.container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
  fireEvent.contextMenu(transcript, { clientX: 10, clientY: 10 })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Find in chat/ }))

  expect(await screen.findByRole('search')).toBeTruthy()
  const input = await screen.findByRole('textbox', { name: 'Find in chat' })
  fireEvent.change(input, { target: { value: 'details' } })
  const status = await screen.findByText('1/1')
  expect(status.getAttribute('aria-live')).toBe('polite')
})

it("the room's /resume opens its home workspace's Session History, across members' agents", () => {
  renderRoom()
  expect(mocks.seen.composer).toEqual({ scope: 'workspace', worktreeId: 'folder:room-home' })
})

it('opens member files and images from the member folder in the room workspace', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  renderRoom()
  fireEvent.click(screen.getByRole('link', { name: 'the report' }), {
    metaKey: true,
    ctrlKey: true
  })

  expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
    '/bots/a/report.html',
    null,
    null,
    expect.objectContaining({
      worktreeId: 'folder:room-home',
      worktreePath: '/rooms/room-1',
      sourceTabId: 'room-tab'
    })
  )

  fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), {
    metaKey: true,
    ctrlKey: true
  })

  expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
    '/bots/a/chart.png',
    null,
    null,
    expect.objectContaining({ worktreeId: 'folder:room-home', worktreePath: '/rooms/room-1' })
  )
})

it("right-click on an owner message or a member's reply offers Copy message, as a chat tab does", async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('api', { ui: { writeClipboardText: writeText } })
  const base = { sequence: 1, revision: 1, observedAt: 1 }
  const turns: unknown[] = fixtures.transcript.data.messages[0].turns
  turns.push({
    operationId: 'op-1',
    botId: 'bot-a',
    botName: 'Scout',
    avatar: null,
    agent: 'claude',
    sessionId: 'bot-group-member-a',
    frozenItems: [
      { ...base, itemId: 'turn', body: { kind: 'turn', turnId: 't', state: 'completed' } },
      {
        ...base,
        itemId: 'reply',
        turnScope: { kind: 'turn', turnItemId: 'turn' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] }
      }
    ]
  })
  try {
    const view = renderRoom()
    for (const id of ['message-1', 'reply']) {
      const row = view.container.querySelector(`[data-native-chat-message-id="${id}"]`)!
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy message' }))
    }
    expect(writeText.mock.calls).toEqual([['See https://example.com/docs for details'], ['Done.']])
  } finally {
    turns.length = 0
    vi.unstubAllGlobals()
  }
})

it('accepts and sends image attachments for a group with members and renders sent owner images', async () => {
  const originalMembers = fixtures.groups[0].members
  const originalMessages = fixtures.transcript.data.messages
  fixtures.groups[0].members = [{ botId: 'bot-a', sessionId: 'bot-group-member-a' }]
  fixtures.transcript.data.messages = [
    {
      id: 'message-img',
      author: { kind: 'owner' },
      text: 'Look at [Image #1]',
      images: [{ path: '/store/u1/shot.png', name: 'shot.png', bytes: 42 }],
      createdAt: 2,
      turns: []
    }
  ]
  mocks.callBotRpc.mockResolvedValue({
    message: {
      id: 'sent-1',
      groupId: 'group-1',
      sequence: 2,
      author: { kind: 'owner' },
      text: '[Image #1]',
      images: [{ path: '/store/u1/shot.png', name: 'shot.png', bytes: 42 }],
      createdAt: 3,
      turns: []
    }
  })
  try {
    renderRoom()
    const transport = mocks.seen.transport
    expect(transport?.acceptsImages).toBe(true)
    expect(transport?.sessionId).toBe('bot-group-member-a')
    expect(transport?.runtime).toBe('local')

    await act(async () => {
      const ok = await transport?.send('[Image #1]', [{ id: '1', path: '/store/u1/shot.png' }])
      expect(ok).toBe(true)
    })
    expect(mocks.callBotRpc).toHaveBeenCalledWith(
      fixtures.groups[0],
      'bots.groups.send',
      expect.objectContaining({
        groupId: 'group-1',
        text: '[Image #1]',
        images: ['/store/u1/shot.png']
      })
    )
    expect(screen.getByText('Look at')).toBeTruthy()
    expect(screen.getByTitle('shot.png')).toBeTruthy()
  } finally {
    fixtures.groups[0].members = originalMembers
    fixtures.transcript.data.messages = originalMessages
  }
})

it('disables image attachments on a paired server that lacks bots.group-attachments.v1', () => {
  const originalHostId = fixtures.groups[0].hostId
  const originalMembers = fixtures.groups[0].members
  fixtures.groups[0].hostId = 'runtime:env-legacy'
  fixtures.groups[0].members = [{ botId: 'bot-a', sessionId: 'bot-group-member-a' }]
  try {
    renderRoom()
    const transport = mocks.seen.transport
    expect(transport?.runtime).toBe('remote')
    expect(transport?.runtimeEnvironmentId).toBe('env-legacy')
    expect(transport?.acceptsImages).toBe(false)
    expect(transport?.sessionPending).toBe(true)
  } finally {
    fixtures.groups[0].hostId = originalHostId
    fixtures.groups[0].members = originalMembers
  }
})
