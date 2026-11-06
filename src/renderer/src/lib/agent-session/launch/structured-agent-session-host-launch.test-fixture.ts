// @vitest-environment happy-dom
/** The host side of a held host launch as the window reads it, and the launches these tests start. */
import { vi } from 'vitest'
import {
  nativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { mocks, target } from '../../structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import type {
  AgentLaunchReleasePhaseStatusResult,
  AgentLaunchStatusResult
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** Puts the opening's files on the host under the launch; answers its host-readable body. */
export type HostLaunchPrepare = (
  launchOperationId: string,
  target: RuntimeClientTarget
) => Promise<StructuredAgentSessionFirstMessage['body']>
import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'

export const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
export const SESSION_ID = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
export const HELD = 'Inspect the failing test and fix it'
export const SOURCE_SCOPE = 'pending-worktree-creation:creation-1'
export const MESSAGE_ID = `${Date.now()}-000000000000000000000000000000ae`
/** The host founded the reserved chat with the first message as its own. */
export const CHAT_STARTED: AgentLaunchStatusResult = {
  state: 'succeeded',
  result: {
    outcome: { kind: 'structured', sessionId: SESSION_ID, handle: 'chat' },
    worktreeId: 'workspace-1',
    receipt: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: '' },
    prompt: { delivery: 'submit', outcome: 'journaled', messageId: MESSAGE_ID }
  } satisfies AgentLaunchResult
}

export const host = {
  accept: vi.fn<(params: unknown) => Promise<unknown>>(),
  status:
    vi.fn<(params: unknown, options: unknown) => Promise<AgentLaunchReleasePhaseStatusResult>>(),
  prepare: vi.fn<(params: unknown) => Promise<unknown>>(),
  release: vi.fn<(params: unknown) => Promise<unknown>>()
}

export function hostAnswers(): void {
  vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, params, options) =>
    method === 'agent.launchAccept'
      ? host.accept(params)
      : method === 'agent.launchStatus'
        ? host.status(params, options)
        : method === 'agent.launchPrepare'
          ? host.prepare(params)
          : method === 'agent.launchRelease'
            ? host.release(params)
            : {}
  )
}

export function startHostLaunch(accept = true) {
  return startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: HELD,
    draftFromScope: SOURCE_SCOPE,
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      opening: { clientMessageId: MESSAGE_ID, body: structuredAgentSessionSendBody(HELD, []) },
      ...(accept
        ? {
            accept: {
              prompt: { text: HELD, clientMessageId: MESSAGE_ID },
              presentation: 'focused' as const,
              setupReceipt: { required: true as const, runId: 'setup-run-1' }
            }
          }
        : {})
    }
  })
}

/** Everything the window asked its host: never a chat create or send of its own. */
export function windowCalls(): string[] {
  return [
    ...vi.mocked(callRuntimeRpc).mock.calls.map(([, method]) => method),
    ...mocks.call.mock.calls.map(([, method]) => method)
  ].filter((method) => method !== 'session.tabs.close')
}

/** The chat's tail as the host has it once the first message is journaled. */
export function hostHistory() {
  const cursor = { epoch: 'epoch-1', sequence: 1 }
  const page: AgentSessionHistoryPage = {
    sessionId: SESSION_ID,
    epoch: cursor.epoch,
    fence: 3,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return { ok: true, page }
}

export const lifecycle = () => getStructuredAgentSessionLaunchLifecycle('workspace-1', SESSION_ID)

export const SAVED = 'orca:structuredAgentLaunches:v1'
export const AWAITING: AgentLaunchReleasePhaseStatusResult = { state: 'awaiting-release' }

export function seedCatalog(): void {
  const efforts = [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ]
  recordHostModelCatalogSnapshot(target, 'codex', null, {
    origin: 'probe',
    fetchedAt: 1,
    defaultHoldsInEveryWorkspace: true,
    models: [
      { id: 'shown-model', label: 'Shown', isDefault: true, efforts },
      { id: 'picked-model', label: 'Picked', isDefault: false, efforts }
    ]
  })
}

export function startReleaseLaunch() {
  return startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: HELD,
    draftFromScope: SOURCE_SCOPE,
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      protocol: 'release',
      opening: {
        clientMessageId: MESSAGE_ID,
        body: structuredAgentSessionSendBody(HELD, [])
      },
      accept: {
        prompt: { text: HELD, clientMessageId: MESSAGE_ID },
        presentation: 'focused',
        setupReceipt: { required: true, runId: 'setup-run-1' },
        terminalAlternative: { kind: 'agent', prompt: 'none' }
      }
    }
  })
}

/** The launch's saved first turn, as a reload would read it. */
export function savedFirstTurn(): Record<string, unknown> | undefined {
  const rows: { sessionId: string; hostLaunchFirstTurn?: Record<string, unknown> }[] = JSON.parse(
    localStorage.getItem(SAVED) ?? '[]'
  )
  return rows.find((row) => row.sessionId === SESSION_ID)?.hostLaunchFirstTurn
}

export const IMAGE = { path: '/client/shot.png', previewUri: '' }
export const SKILLS = [{ name: 'audit', path: '/skills/audit/SKILL.md' }]

/** A held message with a client file staged for the host, uploaded when release needs it. */
export function startRichReleaseLaunch(
  text: string,
  prepareFirstMessage: HostLaunchPrepare,
  release: () => void = () => {}
) {
  return startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: text,
    promptAttachments: [IMAGE],
    promptSkills: SKILLS,
    draftFromScope: SOURCE_SCOPE,
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      protocol: 'release',
      opening: {
        clientMessageId: MESSAGE_ID,
        body: structuredAgentSessionSendBody(text, [IMAGE], SKILLS)
      },
      stagedSources: [IMAGE.path],
      sources: {
        prepare: (_opening, launchOperationId, target) =>
          prepareFirstMessage(launchOperationId, target),
        release
      },
      accept: {
        presentation: 'focused',
        setupReceipt: { required: true, runId: 'setup-run-1' },
        terminalAlternative: { kind: 'none' }
      }
    }
  })
}

/** Whether the composer's draft store (and so any return to the chat's composer) can save, as a
 *  full disk refuses it. Launch rows are refused separately, through localStorage. */
export function refuseDraftWrites(refuse: boolean): void {
  const drafts = nativeChatComposerDraftStorage()
  if ('refuseWrites' in drafts) {
    drafts.refuseWrites = refuse
  }
}

/** The renderer starts again: draft memory, its load and save bookkeeping and the launch registry
 *  go; the stored drafts, the draft journal and the saved launch rows stay. */
export async function coldReload(): Promise<void> {
  const backend = nativeChatComposerDraftStorage()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(backend)
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  await hydrateNativeChatComposerDrafts()
}
