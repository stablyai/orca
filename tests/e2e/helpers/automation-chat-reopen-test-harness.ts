import { createChatRendererBridge } from './automation-chat-renderer-test-harness'
import { expect, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../src/shared/runtime-client-target'
import {
  authorityProfile,
  openAuthorityRuntime,
  root
} from '../../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { editPersistedTestAgentSessionStore } from '../../../src/main/runtime/agent-session-record-store-test-harness'
import {
  codexProviderHandle,
  encodePersistedAgentSessionProviderHandle
} from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  createTestStore,
  makeUnifiedTab
} from '../../../src/renderer/src/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '../../../src/renderer/src/store/slices/worktrees-slice-test-fixtures'
import { createAutomationRunWorkspaceAction } from '../../../src/renderer/src/components/automations/automation-run-workspace-action'
import type { AutomationsPageActionContext } from '../../../src/renderer/src/components/automations/automations-page-action-context'
import { createAutomationRunWriter } from '../../../src/main/automations/automation-run-writer'
import { makeRepo } from '../../../src/main/persistence/persistence-test-harness'
import { structuredAgentSessionTabId } from '../../../src/shared/structured-agent-session-projection'
import { retireStructuredAgentSessionTab } from '../../../src/renderer/src/runtime/structured-agent-session-tab-retirement'

export const CHAT = 'claude_saved_reopen',
  SURVIVOR = 'codex_surviving_chat'

export async function createReopenRig(
  paired: boolean,
  bind: (store: ReturnType<typeof createTestStore>) => void
) {
  const profile = await authorityProfile([], {
    records: [CHAT, SURVIVOR],
    visible: [CHAT, SURVIVOR]
  })
  await editPersistedTestAgentSessionStore(root, (state) => {
    state.sessionTabs = [CHAT, SURVIVOR].map((sessionId) => ({
      sessionId,
      tabId: `agent-session:${sessionId}`
    }))
    const other = state.records[SURVIVOR]!
    other.provider = 'codex'
    other.accountHome = { variable: 'CODEX_HOME', path: `${root}/fixture-codex` }
    other.providerHandleChain[0]!.handle = encodePersistedAgentSessionProviderHandle(
      codexProviderHandle('survivor-thread')
    )
  })
  const rig = await openAuthorityRuntime(profile)
  const store = createTestStore()
  bind(store)
  const target: RuntimeClientTarget = paired
    ? { kind: 'environment', environmentId: 'reopen-host' }
    : { kind: 'local' }
  const hostId = paired ? 'runtime:reopen-host' : 'local'
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace({
        id: rig.folderId,
        projectGroupId: rig.groupId,
        folderPath: root,
        executionHostId: hostId
      })
    ],
    projectGroups: [],
    activeWorktreeId: rig.workspace,
    activeWorkspaceExecutionHostId: hostId
  })
  const renderer = await createChatRendererBridge(rig.runtime, rig.workspace, target, store)
  const { calls, inventory } = renderer
  await rig.runtime.restoreStructuredAgentSessionTabs()
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: CHAT,
    agent: 'claude',
    activate: true
  })
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: SURVIVOR,
    agent: 'codex',
    activate: false
  })
  await inventory()
  const repo = makeRepo({ id: 'reopen-repo', path: root })
  rig.profile.addRepo(repo)
  const automation = rig.profile.createAutomation({
    projectId: repo.id,
    name: 'Saved reopen',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now(),
    prompt: 'Preserved prompt',
    agentId: 'claude',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    enabled: false,
    launchSetupPatch: { surface: 'chat' }
  })
  const writer = createAutomationRunWriter(rig.profile, null)
  const created = await writer.createRun(automation, Date.now(), 'manual')
  const run = await writer.updateRun({
    runId: created.id,
    status: 'completed',
    sessionKind: 'chat',
    chatSessionId: CHAT,
    workspaceId: rig.workspace,
    outputSnapshot: {
      format: 'plain_text',
      content: 'Exact saved output',
      truncated: false,
      capturedAt: Date.now()
    }
  })
  const beforeJournal = await rig.host.journalSnapshot(CHAT)
  const beforeRecord = rig.store.getConversation(CHAT)
  const send = vi.spyOn(rig.host, 'send'),
    create = vi.spyOn(rig.host, 'create')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these row resolvers are read by the real Details action; all Chat/open/close/store owners execute.
  const context = {
    store: { repoForRow: () => undefined, worktreeForRow: () => ({ id: rig.workspace, hostId }) },
    list: { selectedRow: { key: 'saved' } }
  } as unknown as AutomationsPageActionContext
  const action = createAutomationRunWorkspaceAction(context)
  const close = async () => {
    store.getState().closeUnifiedTab(structuredAgentSessionTabId(CHAT))
    await retireStructuredAgentSessionTab({ target, worktreeId: rig.workspace, sessionId: CHAT })
    await inventory()
    expect(rig.host.isSessionTabVisible(CHAT)).toBe(false)
  }
  const unchanged = async () => {
    expect(rig.profile.listAutomationRuns(automation.id)).toEqual([run])
    expect(await rig.host.journalSnapshot(CHAT)).toEqual(beforeJournal)
    expect(rig.store.getConversation(CHAT)).toEqual(beforeRecord)
    expect(send).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(rig.acquire).not.toHaveBeenCalled()
    expect(calls.every(({ method }) => !/create|send|launch/.test(method))).toBe(true)
  }
  const decoy = () => {
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [rig.workspace]: [
          makeUnifiedTab({
            id: 'wrong-owner',
            entityId: CHAT,
            worktreeId: rig.workspace,
            contentType: 'agent-session',
            executionHostId: 'local',
            groupId: 'decoy'
          }),
          ...(state.unifiedTabsByWorktree[rig.workspace] ?? [])
        ]
      }
    }))
  }
  return { ...rig, ...renderer, target, action: () => action(run), close, unchanged, decoy }
}
