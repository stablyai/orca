// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotSchema, type Bot } from '../../../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { findKeybindingActionsForBinding } from '../../../../../../shared/keybindings/formatting'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import { queuedMessageWithEdit } from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit'
import { AGENT_SESSION_SEND_WORK_TARGET_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { useNativeChatComposerKeyDown } from '../editor/use-native-chat-composer-keydown'
import { nativeChatComposerDraftLeftAfterSend } from '../../drafts/native-chat-composer-draft-comparison'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { handBackStructuredAgentSessionMessage } from '../../session/structured/delivery/structured-agent-session-message-hand-back'
import {
  attemptStructuredAgentSessionSend,
  noteStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from '../../session/structured/delivery/structured-agent-session-send-attempt'
import type { StructuredAgentSessionPendingSend } from '../../session/structured/delivery/structured-agent-session-pending-sends'
import { buildBotWorkTargetTree, filterBotWorkTargetTree } from './bot-work-target-tree'
import { NativeChatWorkTargetPicker } from './NativeChatWorkTargetPicker'

const sendMocks = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(async (_target: unknown, _capability: string) => true),
  compatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: sendMocks.call
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: sendMocks.supports
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: sendMocks.compatible
}))

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionFencesForTests()
  sendMocks.call.mockReset()
  sendMocks.supports.mockReset()
  sendMocks.supports.mockResolvedValue(true)
  sendMocks.compatible.mockReset()
  sendMocks.compatible.mockResolvedValue(undefined)
})

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeWorktree(
  overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'path'>
): Worktree {
  return {
    hostId: 'local',
    instanceId: 'inst-1',
    branch: overrides.displayName,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
): FolderWorkspace {
  return {
    projectGroupId: 'grp-ops',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(
  overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>
): ProjectGroup {
  return {
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeBot(id: string, folderWorkspaceId: string): Bot {
  return BotSchema.parse({
    id,
    name: 'HelperBot',
    hostId: 'local',
    folder: 'helper-bot',
    folderWorkspaceId,
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: false,
      taskComplete: false,
      couldNotFinish: false
    },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: 'sess-bot-1',
    createdAt: 1,
    updatedAt: 1
  })
}

describe('bot work target catalog tree and search', () => {
  const localRepo = makeRepo({
    id: 'repo-acme-local',
    displayName: 'acme-api',
    path: '/synth/local/acme-api',
    executionHostId: 'local'
  })
  const remoteRepo = makeRepo({
    id: 'repo-acme-remote',
    displayName: 'acme-api',
    path: '/srv/build/acme-api',
    executionHostId: 'runtime:env-build'
  })
  const offlineSshRepo = makeRepo({
    id: 'repo-staging',
    displayName: 'staging-api',
    path: '/srv/staging/api',
    executionHostId: 'ssh:box-staging'
  })
  const hiddenRepo = makeRepo({
    id: 'repo-hidden',
    displayName: 'secret-repo',
    path: '/synth/local/secret',
    executionHostId: 'local',
    hiddenAt: 100
  })
  const folderRepo = makeRepo({
    id: 'repo-notes',
    displayName: 'design-notes',
    path: '/synth/local/design-notes',
    kind: 'folder',
    executionHostId: 'local'
  })
  const worktreesByRepo = {
    'repo-acme-local': [
      makeWorktree({
        id: 'wt-child',
        repoId: 'repo-acme-local',
        displayName: 'feat/auth-fix',
        branch: 'feat/auth-fix',
        path: '/synth/local/acme-api-auth'
      }),
      makeWorktree({
        id: 'wt-main',
        repoId: 'repo-acme-local',
        displayName: 'main',
        branch: 'main',
        path: '/synth/local/acme-api',
        isMainWorktree: true
      }),
      makeWorktree({
        id: 'wt-archived',
        repoId: 'repo-acme-local',
        displayName: 'archived-exp',
        path: '/synth/local/acme-api-old',
        isArchived: true
      })
    ]
  }
  const worktreeLineageById = {
    'wt-child': { parentWorktreeId: 'wt-main' }
  }
  const folderWorkspaces: FolderWorkspace[] = [
    makeFolderWorkspace({
      id: 'fw-bot-home',
      name: 'HelperBot',
      folderPath: '/synth/bots/helper',
      projectGroupId: 'grp-bots'
    }),
    makeFolderWorkspace({
      id: 'fw-runbooks',
      name: 'runbooks',
      folderPath: '/synth/local/runbooks',
      projectGroupId: 'grp-ops'
    }),
    makeFolderWorkspace({
      id: 'fw-archived',
      name: 'old-folder',
      folderPath: '/synth/local/old-folder',
      isArchived: true
    })
  ]
  const projectGroups: ProjectGroup[] = [
    makeProjectGroup({ id: 'grp-bots', name: 'Bots', tabOrder: 0 }),
    makeProjectGroup({ id: 'grp-ops', name: 'Operations', tabOrder: 1 })
  ]
  const bots = [makeBot('bot-1', 'fw-bot-home')]
  const verifiedEnvStatus: RuntimeEnvironmentStatus = {
    snapshot: {
      environmentId: 'env-build',
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: null,
      verification: 'verified',
      transport: 'ready'
    },
    status: null,
    checkedAt: 1
  }
  const runtimeStatusByEnvironmentId = new Map<string, RuntimeEnvironmentStatus>([
    ['env-build', verifiedEnvStatus]
  ])

  it('builds nested project/worktree/folder rows, excludes hidden/archived/bot homes, disambiguates same names across hosts, and disables unreachable hosts', () => {
    const rows = buildBotWorkTargetTree({
      botHostId: 'local',
      repos: [localRepo, remoteRepo, offlineSshRepo, hiddenRepo, folderRepo],
      worktreesByRepo,
      worktreeLineageById,
      folderWorkspaces,
      projectGroups,
      bots,
      runtimeEnvironments: [{ id: 'env-build', name: 'Build Server' }],
      runtimeStatusByEnvironmentId,
      sshTargetLabels: new Map([['box-staging', 'Staging SSH']]),
      sshConnectionStates: new Map([['box-staging', { status: 'disconnected' }]])
    })

    // Hidden repos, archived worktrees/folders, and bot home folders are never shown.
    expect(rows.map((row) => row.id)).toEqual([
      'project:local:repo-acme-local',
      'workspace:local:wt-main',
      'workspace:local:wt-child',
      'project:runtime:env-build:repo-acme-remote',
      'project:local:repo-notes',
      'project:ssh:box-staging:repo-staging',
      'workspace:local:folder:fw-runbooks'
    ])

    // Nested worktree depth reflects lineage (project 0 -> main 1 -> child 2).
    expect(rows.find((row) => row.id === 'workspace:local:wt-main')?.depth).toBe(1)
    expect(rows.find((row) => row.id === 'workspace:local:wt-child')?.depth).toBe(2)

    // Same-name repos across hosts are flagged ambiguous with distinct host labels and IDs.
    const localAcme = rows.find((row) => row.id === 'project:local:repo-acme-local')
    const remoteAcme = rows.find((row) => row.id === 'project:runtime:env-build:repo-acme-remote')
    expect(localAcme?.ambiguousName).toBe(true)
    expect(localAcme?.hostLabel).toBe('Local')
    expect(remoteAcme?.ambiguousName).toBe(true)
    expect(remoteAcme?.hostLabel).toBe('Build Server')

    // Offline SSH host is marked offline and sorted below available hosts.
    expect(
      rows.find((row) => row.id === 'project:ssh:box-staging:repo-staging')?.unavailableReason
    ).toBe('offline')

    // Multi-token search retains parent project row above matching child worktree.
    const filteredChild = filterBotWorkTargetTree(rows, 'acme auth')
    expect(filteredChild.map((row) => row.id)).toEqual([
      'project:local:repo-acme-local',
      'workspace:local:wt-child'
    ])

    // Searching by host + project disambiguates to the remote copy only.
    const filteredHost = filterBotWorkTargetTree(rows, 'build acme')
    expect(filteredHost.map((row) => row.id)).toEqual([
      'project:runtime:env-build:repo-acme-remote'
    ])

    // A bot running on a paired server marks local projects as other-host.
    const remoteBotRows = buildBotWorkTargetTree({
      botHostId: 'runtime:env-build',
      repos: [localRepo, remoteRepo],
      worktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      bots: [],
      runtimeEnvironments: [{ id: 'env-build', name: 'Build Server' }],
      runtimeStatusByEnvironmentId,
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    })
    expect(
      remoteBotRows.find((row) => row.id === 'project:runtime:env-build:repo-acme-remote')
        ?.unavailableReason
    ).toBeUndefined()
    expect(
      remoteBotRows.find((row) => row.id === 'project:local:repo-acme-local')?.unavailableReason
    ).toBe('other-host')
  })
})

describe('dedicated shortcut, IME safety, and / @ preservation', () => {
  it('registers Mod+Shift+P with zero default conflicts on macOS, Linux, and Windows and matches physical KeyP on Korean layout', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        findKeybindingActionsForBinding('Mod+Shift+P', platform, undefined, [
          'global',
          'tabs',
          'chat'
        ])
      ).toEqual(['chat.pickWorkTarget'])
    }

    // Physical KeyP matches even when Korean IME layout produces Hangul 'ㅔ'.
    expect(
      keybindingMatchesAction(
        'chat.pickWorkTarget',
        {
          key: 'ㅔ',
          code: 'KeyP',
          ctrlKey: true,
          shiftKey: true,
          metaKey: false,
          altKey: false
        },
        'linux'
      )
    ).toBe(true)
  })

  it('opens the picker on Mod+Shift+P without sending, ignores IME composition, and preserves / and @ autocomplete', () => {
    const onOpenWorkTargetPicker = vi.fn()
    const send = vi.fn()
    const completePickerItem = vi.fn()
    const completeMention = vi.fn()
    const dismissPicker = vi.fn()

    function Harness({
      composing = false,
      autocompleteMode = 'none'
    }: {
      composing?: boolean
      autocompleteMode?: 'none' | 'slash' | 'mention'
    }) {
      const autocomplete: ComposerAutocomplete =
        autocompleteMode === 'slash'
          ? {
              mode: 'slash',
              triggerKey: '/rev',
              query: 'rev',
              prefix: '/',
              dispatchable: false,
              grouped: false,
              commandsEnabled: true,
              skillsEnabled: true,
              skillStatus: 'ready',
              items: [
                {
                  kind: 'skill',
                  id: 'skill-review',
                  name: 'review',
                  token: '/review',
                  description: 'Review code',
                  sources: [{ sourceKind: 'home', skillFilePath: '/skills/review/SKILL.md' }]
                }
              ]
            }
          : autocompleteMode === 'mention'
            ? {
                mode: 'mention',
                triggerKey: '@src',
                query: 'src'
              }
            : { mode: 'none' }
      const onKeyDown = useNativeChatComposerKeyDown({
        autocomplete,
        mentionFiles: { files: ['src/index.ts'], loading: false, failed: false },
        completeMention,
        activeSuggestion: 0,
        draft: 'hello',
        isComposing: () => composing,
        completePickerItem,
        dispatchPickerCommand: vi.fn(),
        dismissPicker,
        interrupt: undefined,
        send,
        onOpenWorkTargetPicker,
        keybindingOverrides: {},
        setActiveSuggestion: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn()
      })
      return <textarea aria-label="composer" onKeyDown={onKeyDown} />
    }

    // 1) Ctrl+Shift+KeyP (Korean key 'ㅔ') opens picker and never sends.
    const view = render(<Harness />)
    const box = view.getByLabelText('composer')
    fireEvent.keyDown(box, { key: 'ㅔ', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(onOpenWorkTargetPicker).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    // 2) Active IME composition blocks both picker shortcut and Enter submission.
    view.rerender(<Harness composing />)
    fireEvent.keyDown(box, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    expect(onOpenWorkTargetPicker).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    // 3) Slash autocomplete still completes on Enter cleanly.
    view.rerender(<Harness autocompleteMode="slash" />)
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    expect(completePickerItem).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    // 4) @ mention autocomplete still completes on Enter cleanly.
    view.rerender(<Harness autocompleteMode="mention" />)
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    expect(completeMention).toHaveBeenCalledWith('src/index.ts')
    expect(send).not.toHaveBeenCalled()

    // 5) Plain Enter sends normally.
    view.rerender(<Harness />)
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('navigates picker rows with Arrow keys, skips offline rows, respects IME Enter, and selects or escapes without sending', () => {
    const onSelectTarget = vi.fn()
    const onOpenChange = vi.fn()
    const focusComposer = vi.fn()
    const rows = buildBotWorkTargetTree({
      botHostId: 'local',
      repos: [
        makeRepo({ id: 'repo-alpha', displayName: 'alpha', path: '/synth/alpha' }),
        makeRepo({
          id: 'repo-offline',
          displayName: 'beta-offline',
          path: '/srv/beta',
          executionHostId: 'ssh:box-off'
        }),
        makeRepo({ id: 'repo-gamma', displayName: 'gamma', path: '/synth/gamma' })
      ],
      worktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      bots: [],
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      sshTargetLabels: new Map([['box-off', 'Offline SSH']]),
      sshConnectionStates: new Map([['box-off', { status: 'disconnected' }]])
    })

    const view = render(
      <TooltipProvider>
        <NativeChatWorkTargetPicker
          open
          onOpenChange={onOpenChange}
          botHostId="local"
          supported
          selectedTarget={null}
          onSelectTarget={onSelectTarget}
          focusComposer={focusComposer}
          rowsOverride={rows}
        />
      </TooltipProvider>
    )

    const search = view.getByRole('combobox')
    // Active index starts on first selectable row (alpha); ArrowDown advances to gamma (offline row skipped).
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    // IME composition Enter must not commit selection prematurely.
    fireEvent.keyDown(search, { key: 'Enter', keyCode: 229 })
    expect(onSelectTarget).not.toHaveBeenCalled()

    // Non-composing Enter selects gamma and closes the picker.
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelectTarget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'project', repoId: 'repo-gamma', hostId: 'local' })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Escape closes without altering selection.
    onSelectTarget.mockClear()
    onOpenChange.mockClear()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onSelectTarget).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('draft lifecycle, attachments, queued edits, and fail-closed older-host send', () => {
  const targetA: AgentJournalWorkTarget = {
    kind: 'project',
    hostId: 'local',
    repoId: 'repo-acme',
    repoKind: 'git',
    displayName: 'acme-api'
  }
  const targetB: AgentJournalWorkTarget = {
    kind: 'workspace',
    hostId: 'runtime:env-build',
    repoId: 'repo-acme',
    workspaceId: 'wt-auth',
    workspaceKind: 'git-worktree',
    displayName: 'feat/auth-fix',
    projectName: 'acme-api',
    hostLabel: 'Build Server'
  }

  beforeEach(() => {
    updateNativeChatComposerDraft(
      'bot-chat-a',
      { text: '', images: [], workTarget: null },
      'immediate'
    )
    updateNativeChatComposerDraft(
      'bot-chat-b',
      { text: '', images: [], workTarget: null },
      'immediate'
    )
  })

  it('isolates draft workTarget per chat, consumes once on ordinary send, preserves on slash commands, and restores on failure with attachments', () => {
    // Selecting on an empty draft persists for that chat only and does not affect sibling chats.
    updateNativeChatComposerDraft('bot-chat-a', { workTarget: targetA }, 'immediate')
    expect(readNativeChatComposerDraft('bot-chat-a').workTarget).toEqual(targetA)
    expect(readNativeChatComposerDraft('bot-chat-b').workTarget).toBeUndefined()

    // Ordinary send clears the matching target while keeping newer text and a newer mid-send target.
    const afterOrdinary = nativeChatComposerDraftLeftAfterSend(
      { text: 'First message\nNext thought', images: [], workTarget: targetA },
      { text: 'First message', images: [], workTarget: targetA }
    )
    expect(afterOrdinary).toEqual({ text: '\nNext thought', images: [] })

    const afterTargetChangedMidSend = nativeChatComposerDraftLeftAfterSend(
      { text: 'First message', images: [], workTarget: targetB },
      { text: 'First message', images: [], workTarget: targetA }
    )
    expect(afterTargetChangedMidSend?.workTarget).toEqual(targetB)

    // Slash/host command preserves the armed target for the next ordinary message.
    const afterHostCommand = nativeChatComposerDraftLeftAfterSend(
      { text: '/compact', images: [], workTarget: targetA },
      { text: '/compact', images: [], workTarget: targetA },
      { preserveWorkTarget: true }
    )
    expect(afterHostCommand?.workTarget).toEqual(targetA)

    // Failed/refused send hands back text, image attachments, and workTarget together.
    const sessionId = 'sess-handback-1'
    const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
    updateNativeChatComposerDraft(scopeKey, { text: '', images: [], workTarget: null }, 'immediate')
    handBackStructuredAgentSessionMessage(sessionId, 'op-fail', {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Check this screenshot [Image #1]' },
        { type: 'image-ref', path: '/synth/uploads/screen.png' }
      ],
      workTarget: targetA
    })
    const restored = readNativeChatComposerDraft(scopeKey)
    expect(restored.workTarget).toEqual(targetA)
    expect(restored.images).toHaveLength(1)
    expect(restored.images[0]?.path).toBe('/synth/uploads/screen.png')
    expect(restored.text).toContain('Check this screenshot')

    // Editing a queued card preserves its attached workTarget.
    const edited = queuedMessageWithEdit(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Original queued prompt' }],
        workTarget: targetB
      },
      { text: 'Updated queued prompt' }
    )
    expect(edited.ok).toBe(true)
    if (edited.ok) {
      expect(edited.body.workTarget).toEqual(targetB)
    }
  })

  it('refuses to send rather than stripping workTarget on an older host, and normalizes paired-server self targets to local', async () => {
    const sessionId = 'sess-cap-1'
    noteStructuredAgentSessionFence(sessionId, 2)
    const entry: StructuredAgentSessionPendingSend = {
      sessionId,
      clientMessageId: 'op-cap-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Run tests' }],
        workTarget: targetB
      },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: false,
      imageConnectionIds: []
    }

    // Older host without send-work-target capability: fail closed, zero RPC calls.
    sendMocks.supports.mockImplementation(
      async (_target, capability) =>
        capability !== AGENT_SESSION_SEND_WORK_TARGET_RUNTIME_CAPABILITY
    )
    const refused = await attemptStructuredAgentSessionSend({
      entry,
      target: { kind: 'environment', environmentId: 'env-build' },
      beforeIssue: vi.fn(),
      abandoned: () => false,
      reconcile: vi.fn()
    })
    expect(refused).toEqual({
      kind: 'not-sent',
      parts: ['workTargetHostUnsupported', 'notDoneSend']
    })
    expect(sendMocks.call).not.toHaveBeenCalled()

    // Updated paired server advertising the capability: normalizes runtime:env-build -> local on the wire.
    sendMocks.supports.mockResolvedValue(true)
    sendMocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 2,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: 'op-cap-1',
        submission: { clientMessageId: 'op-cap-1', dispatchState: 'accepted', submittedAt: 1 }
      }
    })
    const sent = await attemptStructuredAgentSessionSend({
      entry,
      target: { kind: 'environment', environmentId: 'env-build' },
      beforeIssue: vi.fn(),
      abandoned: () => false,
      reconcile: vi.fn()
    })
    expect(sent?.kind).toBe('answered')
    expect(sendMocks.call).toHaveBeenCalledTimes(1)
    expect(sendMocks.call.mock.calls[0]?.[2]).toMatchObject({
      body: {
        workTarget: {
          kind: 'workspace',
          hostId: 'local',
          workspaceId: 'wt-auth'
        }
      }
    })
  })
})
