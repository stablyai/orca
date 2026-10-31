// @vitest-environment happy-dom
import React, { act } from 'react'
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitHubWorkItemTargetContext } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../../shared/github/work-item-target'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../../../shared/source-control-runtime-capabilities'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { Repo } from '../../../../../shared/repo-types'
import { ConversationTab } from './tab'

const io = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: io.rpc,
  clearRuntimeCompatibilityCache: vi.fn(),
  clearRecentRuntimeCompatibilityFailure: vi.fn()
}))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { getDefaultSettings } = await import('../../../../../shared/constants')
  return {
    useAppStore: create(() => ({
      settings: getDefaultSettings('/mention-fixture'),
      repos: [],
      projects: [],
      projectHostSetups: [],
      folderWorkspacePathStatuses: {},
      sshConnectionStates: {},
      sshStateByEnvironment: {},
      runtimeStatusByEnvironmentId: {},
      patchWorkItem: vi.fn(),
      patchProjectRowContent: vi.fn(),
      recordFeatureInteraction: vi.fn(),
      setContextualToursBlockingSurfaceVisible: vi.fn()
    }))
  }
})

let fixtureNumber = 0
let environmentId: string
let capable: boolean
let assignableUsers: GitHubAssignableUser[]
let targetContext: React.ContextType<typeof GitHubWorkItemTargetContext>
const repository = { host: 'github.corp', owner: 'fork', repo: 'widgets' }
const item: GitHubWorkItem = {
  id: 'pr:93',
  repoId: 'clone',
  type: 'pr',
  number: 93,
  title: 'Selected pull request',
  state: 'open',
  labels: [],
  author: 'pr-author',
  updatedAt: '2026-10-29T12:00:00Z',
  url: 'https://github.corp/fork/widgets/pull/93',
  prRepo: repository
}
function repo(user = 'A'): Repo {
  return {
    id: 'clone',
    path: '/clone',
    displayName: 'clone',
    badgeColor: '',
    addedAt: 0,
    executionHostId: `runtime:${environmentId}`,
    ghAccount: { host: repository.host, user }
  }
}

beforeEach(async () => {
  environmentId = `mention-fixture-${++fixtureNumber}`
  targetContext = {
    resource: { repository, type: 'pr', number: item.number },
    target: { kind: 'environment', environmentId }
  }
  capable = false
  assignableUsers = []
  io.rpc.mockReset()
  io.rpc.mockImplementation(
    async (
      target: RuntimeClientTarget,
      method: string,
      _params: unknown,
      options?: { beforeSend?: () => void }
    ) => {
      expect(target).toEqual({ kind: 'environment', environmentId })
      options?.beforeSend?.()
      if (method === 'status.get') {
        return {
          runtimeId: environmentId,
          capabilities: capable ? [GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY] : []
        }
      }
      if (method === 'github.project.listAssignableUsersBySlug') {
        return { ok: true, users: [] }
      }
      if (method === 'github.listAssignableUsers') {
        return assignableUsers
      }
      throw new Error(`Unexpected Conversation I/O: ${method}`)
    }
  )
  useAppStore.setState({ repos: [repo()] })
  await i18n.changeLanguage(await loadRendererUiLanguage('en'))
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  vi.restoreAllMocks()
})

function mountConversation(onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>) {
  return render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <GitHubWorkItemTargetContext.Provider value={targetContext}>
          <div onKeyDown={onKeyDown}>
            <ConversationTab
              item={item}
              repoPath="/clone"
              repoId="clone"
              body=""
              comments={[
                {
                  id: 7,
                  author: 'comment-author',
                  authorAvatarUrl: '',
                  body: 'Thanks for the change.',
                  createdAt: '2026-10-29T12:00:00Z',
                  url: ''
                }
              ]}
              participants={[{ login: 'participant', name: 'Pat', avatarUrl: '' }]}
              files={[]}
              headSha={undefined}
              baseSha={undefined}
              loading={false}
              detailsLoaded
              checks={[]}
              localState="open"
              projectOrigin={undefined}
              onStateChange={vi.fn()}
              onMutated={vi.fn()}
              onChecksUpdated={vi.fn()}
              onBodyUpdated={vi.fn()}
              onCommentAdded={vi.fn()}
              onReviewersRequested={vi.fn()}
            />
          </div>
        </GitHubWorkItemTargetContext.Provider>
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

function edit(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, {
    target: { value, selectionStart: value.length, selectionEnd: value.length }
  })
}

it.each(['en', 'de'] as const)(
  'passes the real %s Conversation assignee refusal to surviving mentions without gating Send',
  async (language) => {
    await i18n.changeLanguage(await loadRendererUiLanguage(language))
    const keys: { key: string; prevented: boolean }[] = []
    mountConversation((event) => keys.push({ key: event.key, prevented: event.defaultPrevented }))
    const input = screen.getByPlaceholderText<HTMLTextAreaElement>(
      language === 'de' ? 'Kommentar hinzufügen…' : 'Add a comment…'
    )
    const send = screen.getByRole<HTMLButtonElement>('button', {
      name: language === 'de' ? 'Kommentar senden' : 'Send comment'
    })
    expect(send.disabled).toBe(true)
    edit(input, 'Draft for @')
    const listbox = await screen.findByRole('listbox')
    await within(listbox).findByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)
    expect(screen.getAllByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)).toHaveLength(1)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe(listbox.id)
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    const sourceLabels =
      language === 'de'
        ? ['PR-Autor', 'Kommentarautor', 'Teilnehmer']
        : ['PR author', 'Commenter', 'Participant']
    for (const [index, login] of ['pr-author', 'comment-author', 'participant'].entries()) {
      const option = within(listbox).getByRole('option', { name: new RegExp(`@${login}`) })
      expect(within(option).getByText(sourceLabels[index])).toBeTruthy()
    }
    expect(send.disabled).toBe(false)
    expect(io.rpc.mock.calls.some((call) => call[1] === 'status.get')).toBe(true)
    expect(io.rpc.mock.calls.some((call) => call[1] === 'github.listAssignableUsers')).toBe(false)
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /@comment-author/ }))
    expect(input.value).toBe('Draft for @comment-author')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(send.disabled).toBe(false)

    edit(input, 'Draft without a query')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)).toBeNull()
    const unmatched = 'Draft for @zzzz36172nomatch'
    edit(input, unmatched)
    const errorOnly = screen.getByRole('listbox')
    expect(within(errorOnly).getAllByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)).toHaveLength(1)
    expect(within(errorOnly).queryAllByRole('option')).toHaveLength(0)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    keys.length = 0
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab']) {
      const event = createEvent.keyDown(input, { key, bubbles: true, cancelable: true })
      expect(() => fireEvent(input, event)).not.toThrow()
      expect(event.defaultPrevented).toBe(false)
      expect(input.value).toBe(unmatched)
      expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    }
    expect(keys).toEqual(
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].map((key) => ({ key, prevented: false }))
    )
    // DOM fixtures do not perform the browser's default newline insertion; deliver its normal change.
    edit(input, `${unmatched}\ncontinued draft`)
    expect(input.value).toBe(`${unmatched}\ncontinued draft`)
    expect(screen.queryByRole('listbox')).toBeNull()
    edit(input, unmatched)
    const escape = createEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(input, escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.hasAttribute('aria-controls')).toBe(false)
    expect(input.value).toBe(unmatched)
    expect(send.disabled).toBe(false)
    expect(
      io.rpc.mock.calls.every((call) =>
        ['status.get', 'github.project.listAssignableUsersBySlug'].includes(call[1])
      )
    ).toBe(true)
  }
)

it('recovers the same Conversation draft through real owner metadata and keeps no-error empty matches collapsed', async () => {
  mountConversation()
  const input = screen.getByPlaceholderText<HTMLTextAreaElement>('Add a comment…')
  const unmatched = 'Keep this @zzzz36172nomatch'
  edit(input, unmatched)
  await screen.findByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)
  capable = true
  assignableUsers = ['team-one', 'team-two'].map((login) => ({ login, name: null, avatarUrl: '' }))
  await act(async () => {
    useAppStore.setState({ repos: [repo('B')] })
  })
  await waitFor(() =>
    expect(io.rpc.mock.calls.some((call) => call[1] === 'github.listAssignableUsers')).toBe(true)
  )
  await waitFor(() => expect(screen.queryByText(GITHUB_EXACT_OPERATION_UNSUPPORTED)).toBeNull())
  expect(screen.getByPlaceholderText('Add a comment…')).toBe(input)
  expect(input.value).toBe(unmatched)
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  edit(input, 'No mention query')
  expect(screen.queryByRole('listbox')).toBeNull()
  edit(input, 'Keep this @team')
  const listbox = await screen.findByRole('listbox')
  const options = within(listbox).getAllByRole('option')
  expect(options).toHaveLength(2)
  expect(within(options[0]).getByText('Team member')).toBeTruthy()
  expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
  expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false)
  expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id)
  expect(options[1].getAttribute('aria-selected')).toBe('true')
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false)
  expect(input.value).toBe('Keep this @team-two')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send comment' }).disabled).toBe(
    false
  )
  expect(
    io.rpc.mock.calls
      .filter((call) => call[1] === 'github.listAssignableUsers')
      .map((call) => call[2])
  ).toEqual([{ repo: 'clone', ownerRepo: repository }])
})
