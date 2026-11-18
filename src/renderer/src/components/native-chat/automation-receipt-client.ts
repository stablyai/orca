import { useAppStore } from '@/store'
import { acknowledgeAutomationDefinition } from '@/components/automations/events/automation-definition-acknowledgements'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationReceiptRead } from '../../../../shared/automations/automation-receipt-read'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import type { WebhookKey } from '../../../../shared/rpc-contract/webhooks-params'
import { readAutomationReceiptFacts } from '../../../../shared/automations/automation-receipt-facts'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host/execution-host'

export type AutomationReceiptSource = {
  target: RuntimeClientTarget
  sessionId: string
  itemId: string
  automationId: string
  createdAt: number | null
  botId: string | undefined
  pairingRevision?: number
  runtimeId?: string
}

/** Called on intent, never by folded-card rendering. No authority is taken from the saved body. */
export function captureAutomationReceiptSource(
  owner: NativeChatVisualOwner | null,
  itemId: string | undefined,
  saved: NonNullable<NativeChatMessage['automationSaved']>
): AutomationReceiptSource | null {
  if (!owner || !itemId) {
    return null
  }
  const facts = readAutomationReceiptFacts(saved.receiptFacts)
  const source: AutomationReceiptSource = {
    target: owner.target,
    sessionId: owner.sessionId,
    itemId,
    automationId: saved.automation.id,
    createdAt: facts && !('unavailable' in facts) ? facts.automationCreatedAt : null,
    botId: saved.automation.bot?.botId
  }
  if (owner.target.kind === 'environment') {
    const id = owner.target.environmentId
    const revision = getRuntimeEnvironmentRevision(id)
    const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(id)
    const status = lastVerifiedRuntimeStatus(entry)
    if (revision === undefined || isRuntimeHostContactRevoked(entry) || !status?.runtimeId) {
      return null
    }
    source.pairingRevision = revision
    source.runtimeId = status.runtimeId
  }
  return source
}

export function automationReceiptSourceCurrent(source: AutomationReceiptSource): boolean {
  if (source.target.kind === 'local') {
    return true
  }
  const id = source.target.environmentId
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(id)
  return (
    !isRuntimeHostContactRevoked(entry) &&
    getRuntimeEnvironmentRevision(id) === source.pairingRevision &&
    lastVerifiedRuntimeStatus(entry)?.runtimeId === source.runtimeId
  )
}

async function call<T>(
  source: AutomationReceiptSource,
  method: string,
  params: unknown
): Promise<T> {
  if (!automationReceiptSourceCurrent(source)) {
    throw new Error('The chat’s host changed. Reopen the chat to check this receipt.')
  }
  const result = await callRuntimeRpc<T>(source.target, method, params, {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: source.pairingRevision,
    expectedEnvironmentRuntimeId: source.runtimeId
  })
  if (!automationReceiptSourceCurrent(source)) {
    throw new Error('The chat’s host changed.')
  }
  return result
}

export async function readAutomationReceipt(
  source: AutomationReceiptSource
): Promise<AutomationReceiptRead> {
  let result: AutomationReceiptRead
  try {
    result = await call<AutomationReceiptRead>(source, 'agentSession.automationReceipt', {
      sessionId: source.sessionId,
      itemId: source.itemId
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return { status: 'unverified' }
    }
    throw error
  }
  if (
    result.status === 'ready' &&
    (source.createdAt === null ||
      result.automation.id !== source.automationId ||
      result.automation.createdAt !== source.createdAt ||
      result.automation.bot?.botId !== source.botId)
  ) {
    return { status: 'mismatch' }
  }
  return result
}

export async function openCardAutomation(
  owner: NativeChatVisualOwner | null,
  itemId: string | undefined,
  saved: NonNullable<NativeChatMessage['automationSaved']>,
  shortened: boolean,
  signal: AbortSignal
): Promise<'opened' | 'unavailable' | 'stale'> {
  if (signal.aborted) {
    return 'stale'
  }
  if (!owner) {
    return 'unavailable'
  }
  const source = shortened ? null : captureAutomationReceiptSource(owner, itemId, saved)
  if (!source) {
    return 'unavailable'
  }
  const initial = useAppStore.getState()
  const activeView = initial.activeView
  const activeWorkspace = initial.activeWorktreeId
  const activeGroup = initial.activeGroupIdByWorktree[owner.worktreeId]
  const sourceGroup =
    initial.unifiedTabsByWorktree[owner.worktreeId]?.find((tab) => tab.id === owner.tabId)
      ?.groupId ?? activeGroup
  const activeTab = initial.groupsByWorktree[owner.worktreeId]?.find(
    (group) => group.id === sourceGroup
  )?.activeTabId
  const sameView = (): boolean => {
    const state = useAppStore.getState()
    return (
      state.activeView === activeView &&
      state.activeWorktreeId === activeWorkspace &&
      state.activeGroupIdByWorktree[owner.worktreeId] === activeGroup &&
      state.groupsByWorktree[owner.worktreeId]?.find((group) => group.id === sourceGroup)
        ?.activeTabId === activeTab
    )
  }
  let current = true
  // Leaving and returning is a new view generation, even if its final IDs match.
  const unsubscribe = useAppStore.subscribe(() => {
    current &&= sameView()
  })
  signal.addEventListener('abort', unsubscribe, { once: true })
  const accepts = (): boolean => current && !signal.aborted && sameView()
  try {
    const result = await readAutomationReceipt(source)
    if (!accepts()) {
      return 'stale'
    }
    return result.status === 'ready' &&
      openReceiptAutomation(source, result.automation, result.owner, null)
      ? 'opened'
      : 'unavailable'
  } catch (error) {
    if (!accepts()) {
      return 'stale'
    }
    throw error
  } finally {
    signal.removeEventListener('abort', unsubscribe)
    unsubscribe()
  }
}

export async function readReceiptRuns(
  source: AutomationReceiptSource,
  id: string,
  owner: AutomationOwnerPrecondition
): Promise<AutomationRun[]> {
  const result = await call<{ runs: AutomationRun[] }>(source, 'automation.runs', {
    automationId: id,
    expectedOwner: owner,
    limit: 3,
    preview: true
  })
  return result.runs.slice(0, 3)
}

export async function updateReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition,
  enabled: boolean
): Promise<Automation> {
  const result = await call<{ automation: Automation }>(source, 'automation.update', {
    id: automation.id,
    expectedOwner: owner,
    updates: { enabled }
  })
  acknowledgeAutomationDefinition(source.target, automation.id)
  return result.automation
}

export async function deleteReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition
): Promise<boolean> {
  const result = await call<{ removed: boolean; id: string }>(source, 'automation.delete', {
    id: automation.id,
    expectedOwner: owner
  })
  if (result.removed) {
    acknowledgeAutomationDefinition(source.target, automation.id)
  }
  return result.removed
}

export async function runReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition
): Promise<void> {
  await call(source, 'automation.runNow', { id: automation.id, expectedOwner: owner })
}

export async function readReceiptWebhookKey(
  source: AutomationReceiptSource,
  hookId: string
): Promise<WebhookKey> {
  return await call(source, 'webhooks.reveal', { hookId })
}

export function openReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition,
  runId: string | null
): boolean {
  if (
    !automationReceiptSourceCurrent(source) ||
    source.automationId !== automation.id ||
    source.createdAt !== automation.createdAt ||
    source.botId !== automation.bot?.botId ||
    owner.selector.kind === 'orphan' ||
    (source.target.kind === 'environment' && owner.selector.kind === 'ssh')
  ) {
    return false
  }
  const state = useAppStore.getState()
  const authority =
    source.target.kind === 'environment'
      ? {
          kind: 'runtime' as const,
          environmentId: source.target.environmentId,
          pairingRevision: source.pairingRevision!
        }
      : { kind: 'desktop' as const }
  state.setPendingAutomationRunNavigation({
    automationId: automation.id,
    runId,
    expectedDefinition: {
      owner: { authority, selector: owner.selector },
      createdAt: automation.createdAt,
      runtimeId: source.runtimeId
    },
    hostId:
      source.target.kind === 'environment'
        ? toRuntimeExecutionHostId(source.target.environmentId)
        : owner.selector.kind === 'ssh'
          ? toSshExecutionHostId(owner.selector.targetId)
          : 'local'
  })
  state.openAutomationsPage()
  return true
}
