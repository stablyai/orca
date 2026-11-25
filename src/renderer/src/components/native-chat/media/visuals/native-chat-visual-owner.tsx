import { useAppStore } from '@/store'
import { automationOwnerForHostId } from '@/components/automations/hosts/automation-host-owner'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { AutomationOwnerRef } from '../../../../../../shared/automations/ownership/automation-owner-ref'
import { createContext, useContext, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useNativeChatTabOwnerWorktreeId } from '../../pane/ownership/use-native-chat-tab-owner'

export type NativeChatVisualOwner = {
  target: RuntimeClientTarget
  sessionId: string
  worktreeId: string
  tabId?: string
  automationOwner?: AutomationOwnerRef | null
}

export function captureNativeChatVisualOwner(
  target: RuntimeClientTarget,
  sessionId: string,
  worktreeId: string,
  tabId?: string
): NativeChatVisualOwner {
  return {
    target,
    sessionId,
    worktreeId,
    tabId,
    automationOwner: automationOwnerForHostId(
      getRuntimeTargetHostId(target),
      useAppStore.getState()
    )
  }
}

export const NativeChatVisualOwnerContext = createContext<NativeChatVisualOwner | null>(null)

/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

/** Null for a bridge chat (no target), which reads no visuals. */
export function useNativeChatTranscriptVisualOwner(
  target: RuntimeClientTarget | null,
  sessionId: string | null,
  worktreeId: string | null,
  tabId: string
): NativeChatVisualOwner | null {
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const hasTarget = target !== null
  return useMemo<NativeChatVisualOwner | null>(
    () =>
      worktreeId && hasTarget && sessionId !== null
        ? captureNativeChatVisualOwner(
            environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            sessionId,
            worktreeId,
            tabId
          )
        : null,
    [environmentId, hasTarget, sessionId, tabId, worktreeId]
  )
}

export function useNativeChatTabVisualOwner(
  target: RuntimeClientTarget | null,
  sessionId: string | null,
  tabId: string
): NativeChatVisualOwner | null {
  return useNativeChatTranscriptVisualOwner(
    target,
    sessionId,
    useNativeChatTabOwnerWorktreeId(tabId),
    tabId
  )
}
