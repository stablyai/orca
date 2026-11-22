// @vitest-environment happy-dom

import { createRef } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const sent = vi.fn()
const mentionQueries = vi.hoisted((): (string | null)[] => [])
vi.mock('../../native-chat/composer/pickers/use-native-chat-mention-files', () => ({
  useNativeChatMentionFiles: ({ query }: { query: string | null }) => {
    mentionQueries.push(query)
    return { files: query === null ? [] : ['src/review.txt'], loading: false, failed: false }
  }
}))
const OTHER_BOTS = vi.hoisted(() => [
  { id: 'perf', hostId: 'local', name: 'Perf bot', paused: false }
])
vi.mock('@/lib/bot-catalog', () => ({
  useBots: (enabled: boolean) => (enabled ? OTHER_BOTS : []),
  useBotsEnabled: () => true
}))
vi.mock('../bot-workspace', () => ({ useBotForWorkspace: () => null }))
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue({ bots: [] })
}))
vi.mock('../../native-chat/composer/pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({
    status: 'ready',
    skills: [
      {
        id: 'release-notes',
        name: 'release-notes',
        description: 'Write the release notes',
        providers: ['claude'],
        sourceKind: 'repo',
        sourceLabel: 'Repository',
        rootPath: '/bots/b/.claude/skills',
        directoryPath: '/bots/b/.claude/skills/release-notes',
        skillFilePath: '/bots/b/.claude/skills/release-notes/SKILL.md',
        installed: true,
        updatedAt: null
      }
    ],
    error: null,
    retry: () => {}
  })
}))

import { BotItemCommentBox, type BotItemCommentBoxHandle } from './BotItemCommentBox'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { imageReferenceToken } from '../../../../../shared/native-chat/attachments/native-chat-image-reference'
import {
  changePrompt,
  promptValue
} from '../../native-chat/composer/editor/native-chat-prompt-editor.test-support'
import { TooltipProvider } from '@/components/ui/tooltip'

// The app root provides tooltips; the mic's needs it here too.
const render = (ui: React.ReactElement) => renderBare(ui, { wrapper: TooltipProvider })

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

afterEach(() => {
  cleanup()
  sent.mockClear()
})

function renderBox(ref?: React.Ref<BotItemCommentBoxHandle>, uid = 6, bot = BOT) {
  render(
    <BotItemCommentBox
      ref={ref}
      bot={bot}
      item={makeTestBotItem(uid)}
      attachTo={null}
      onSend={sent}
    />
  )
  return screen.getByRole('textbox', { name: 'Comment' })
}

it('sends on Enter, adds a line on Shift+Enter, and leaves an IME composing Enter alone', () => {
  const box = renderBox(undefined, 61)
  changePrompt(box, 'Go with the proposed flow.')

  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
  expect(sent).not.toHaveBeenCalled()
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
  expect(sent).not.toHaveBeenCalled()

  fireEvent.keyDown(box, { key: 'Enter' })
  expect(sent).toHaveBeenCalledWith('Go with the proposed flow.', [], null, [])
})

it('types a redirected key into the box at its caret and focuses it', () => {
  const handle = createRef<BotItemCommentBoxHandle>()
  const box = renderBox(handle, 62)

  act(() => handle.current?.type('g'))
  act(() => handle.current?.type('o'))

  expect(promptValue(box)).toBe('go')
  expect(box.contains(document.activeElement)).toBe(true)
})

it("completes a workspace file at @ from the bot's folder, as chat does, instead of sending", () => {
  const box = renderBox(undefined, 65)
  changePrompt(box, 'Look at @rev')

  expect(screen.getByRole('listbox')).toBeTruthy()
  expect(mentionQueries.at(-1)).toBe('rev')
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })

  expect(sent).not.toHaveBeenCalled()
  expect(promptValue(box)).toContain('src/review.txt')
})

it("offers chat's bots at @ and skills at /, and sends the same tokens chat does", () => {
  const handle = createRef<BotItemCommentBoxHandle>()
  const box = renderBox(handle, 68, { ...BOT, agent: 'claude' })
  changePrompt(box, 'Ask @perf')
  expect(screen.getByRole('option', { name: /Perf bot/ })).toBeTruthy()
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
  expect(promptValue(box)).toBe('Ask [Bot: Perf bot](bot:perf) ')

  changePrompt(box, '/release')
  expect(screen.getByRole('option', { name: /release-notes/ })).toBeTruthy()
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
  expect(sent).not.toHaveBeenCalled()
  // Picked twice, it goes once, as chat sends it.
  act(() => handle.current?.type('then /release'))
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
  fireEvent.keyDown(box, { key: 'Enter' })

  expect(sent).toHaveBeenCalledWith('/release-notes then /release-notes', [], null, [
    { name: 'release-notes', path: '/bots/b/.claude/skills/release-notes/SKILL.md' }
  ])
})

it('leaves Escape to the item pane when empty, and keeps it with a draft', () => {
  const box = renderBox(undefined, 67)
  // fireEvent returns false when a handler took the key (preventDefault).
  expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true)
  changePrompt(box, 'half a thought')
  expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false)
})

it("numbers an image's pill by its thumbnail and posts it as [Image #N], as chat sends it", async () => {
  const item = makeTestBotItem(66)
  updateNativeChatComposerDraft(
    `bot-item-comment:${botRefKey(BOT)}:${item.uid}`,
    {
      text: `Before ${imageReferenceToken('b')} after ${imageReferenceToken('a')} `,
      images: [
        { id: 'a', path: '/store/a.png' },
        { id: 'b', path: '/store/b.png' }
      ]
    },
    'immediate'
  )
  render(<BotItemCommentBox bot={BOT} item={item} attachTo={null} onSend={sent} />)
  const box = screen.getByRole('textbox', { name: 'Comment' })

  await waitFor(() =>
    expect(
      [...box.querySelectorAll('[data-native-chat-image-reference]')].map(
        (pill) => pill.textContent
      )
    ).toEqual(['Image #2', 'Image #1'])
  )
  fireEvent.keyDown(box, { key: 'Enter' })

  expect(sent).toHaveBeenCalledWith(
    'Before [Image #2] after [Image #1]',
    ['/store/a.png', '/store/b.png'],
    null,
    []
  )
})
