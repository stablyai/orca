import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { createRef } from 'react'
import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from '@/components/native-chat/NativeChatComposerField'
import type { NativeChatComposerInput } from '@/components/native-chat/native-chat-composer-input'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as structuredSessionClient from '@/runtime/structured-agent-session-client'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { resetStructuredAgentLaunchRegistryForTests } from './launch/structured-agent-session-launch-registry'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { clearNativeChatPendingAttachmentsForTests } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
const rpcMock = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))
export const rpc = rpcMock
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<typeof structuredSessionClient>()),
  callStructuredAgentSession: rpcMock.call,
  supportsStructuredAgentSessionCreateMessage: async () => false
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => []
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

export let main: TabsDrawnFromMain
export let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetLocalStructuredSessionVersionForTests()
  storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})
const pendingPositions: { cancel(): void; finish(): Promise<void> }[] = []
afterEach(async () => {
  for (const pending of pendingPositions.splice(0)) {
    pending.cancel()
    await pending.finish()
  }
  vi.restoreAllMocks()
  main.close()
})

export const POSITION_TEXT = 'Hand Off\ncontext  '
export function openPositionDraft() {
  const creation = Promise.withResolvers<unknown>()
  rpc.call.mockImplementation((_target, method) =>
    method === 'agentSession.create'
      ? creation.promise
      : Promise.resolve({ ok: true, supported: true })
  )
  const plan = adoptAgentSessionLaunchVerdict({
    requestId: 'position',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    prompt: POSITION_TEXT,
    promptDelivery: 'draft'
  })
  const handle = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    focusIntent: { request: vi.fn(), cancel: vi.fn() }
  })
  if (!handle?.tab) {
    throw new Error('Expected destination')
  }
  const finish = async () => {
    creation.resolve({
      ok: true,
      value: { sessionId: handle.sessionId, fence: 1, page: { submissions: [] } }
    })
    await handle.settlement
    await main.settle()
  }
  pendingPositions.push({ cancel: handle.cancel, finish })
  return { ...handle, finish }
}
export function PositionField({
  scope,
  input,
  tabId = 'ordinary',
  disabled = false
}: {
  scope: string
  input: ReturnType<typeof createRef<NativeChatComposerInput>>
  tabId?: string
  disabled?: boolean
}) {
  const ime = useImeEnterGestureOwnership()
  const draft = useNativeChatDraft(scope, ime.isComposing)
  const noop = () => {}
  const props: NativeChatComposerFieldProps = {
    draftScopeKey: scope,
    textareaRef: input,
    draft: draft.draft,
    disabled,
    hasPty: false,
    canSend: false,
    autocomplete: { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    activeSuggestion: 0,
    notices: [],
    imageAttachments: [],
    sendButtonDisabled: true,
    isWorking: false,
    attachDisabled: true,
    dictationDisabled: true,
    isDictating: false,
    isDictationHoldMode: false,
    imeEnterGesture: ime,
    onDraftChange: (value) => draft.setDraft(value),
    onTextareaSelect: noop,
    onKeyDown: noop,
    onImeSettled: (element) => {
      draft.setDraft(element.value)
      draft.flushDraftAppends()
    },
    onPaste: noop,
    pickerListboxId: 'position',
    onChoosePickerItem: noop,
    onRetrySkills: noop,
    onChooseMentionFile: noop,
    onRemoveImageAttachment: noop,
    onAttach: noop,
    onDictationToggle: noop,
    onDictationHoldStart: noop,
    onDictationHoldEnd: noop,
    onSend: noop,
    sessionOptionsSurface: null,
    sessionOptionsSnapshot: []
  }
  return (
    <TooltipProvider>
      <NativeChatComposerField {...props} positionTarget={tabId} />
    </TooltipProvider>
  )
}

export function positionInventory(
  sessionId: string | null,
  version: number
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'position-epoch',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionId
      ? [
          {
            type: 'agent-session',
            id: `agent-session:${sessionId}`,
            sessionId,
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }
        ]
      : []
  }
}
export async function startPositionMain() {
  main = await drawTabsFromMain(useAppStore)
}
