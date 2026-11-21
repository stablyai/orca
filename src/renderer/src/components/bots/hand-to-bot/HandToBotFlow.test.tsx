// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BotCatalog from '@/lib/bot-catalog'
import type * as HandToBotWorkspace from './hand-to-bot-workspace'
import type { Bot } from '../../../../../shared/bot-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { HandToBotFlow } from './HandToBotFlow'

type NewBotDialogProps = {
  onOpenChange: (open: boolean, made?: Bot) => void
  onCreated?: (bot: Bot) => void
}

const mocks = vi.hoisted(() => {
  const state: { newBotDialog: NewBotDialogProps | null } = { newBotDialog: null }
  return state
})

vi.mock('../NewBotDialog', () => ({
  NewBotDialog: (props: NewBotDialogProps) => {
    mocks.newBotDialog = props
    return <div data-new-bot-dialog="true" />
  }
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  useBots: () => [],
  takeOverWorkspace: vi.fn()
}))
// No home to move under: the hand-over fails before touching the workspace.
vi.mock('./hand-to-bot-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof HandToBotWorkspace>()),
  botHomeParentFor: () => null
}))
vi.mock('@/components/sidebar/workspace-card/activity/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => []
}))
vi.mock('../use-bot-purposes', () => ({ useBotPurposes: () => new Map<string, string>() }))
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span /> }))

const worktree: Worktree = {
  id: 'repo-1::/tmp/feature',
  repoId: 'repo-1',
  path: '/tmp/feature',
  head: 'abc123',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const madeBot: Bot = {
  id: 'bot-1',
  name: 'Feature bot',
  hostId: 'local',
  folder: 'feature-bot',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

let root: Root
let container: HTMLDivElement

const pickerShown = (): boolean =>
  Array.from(document.body.querySelectorAll('button')).some((button) =>
    button.textContent?.includes('New bot…')
  )

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.newBotDialog = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<HandToBotFlow request={{ worktree, key: 1 }} />))
  const newBot = Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('New bot…')
  )
  act(() => newBot!.click())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HandToBotFlow new bot', () => {
  it('keeps the picker closed after creation and reopens it when the handover fails', async () => {
    const { onOpenChange, onCreated } = mocks.newBotDialog!
    act(() => onOpenChange(false, madeBot))
    expect(pickerShown()).toBe(false)
    expect(document.body.querySelector('[data-new-bot-dialog]')).toBeNull()
    await act(async () => onCreated!(madeBot))
    expect(pickerShown()).toBe(true)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Feature bot')
  })
})
