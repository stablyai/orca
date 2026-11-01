import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  prepareNativeChatCliFork,
  type NativeChatCliForkSubject
} from '@/lib/native-chat-cli-fork-preparation'
import {
  assertAiVaultCopiedSessionLaunchAllowed,
  buildAiVaultCopiedSessionStartupForWorktree,
  buildAiVaultForkStartupForWorktree
} from '@/lib/ai-vault-session-fork-startup'
import { launchAiVaultSessionAndReveal } from '@/lib/launch-ai-vault-session-and-reveal'
import { notifyAiVaultSessionPreparationFailure } from '../right-sidebar/ai-vault-session-launch-feedback'
import { describeAiVaultCliForkFailure } from '../right-sidebar/ai-vault-session-cli-fork'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import {
  resolveNativeChatCliForkIdentity,
  type NativeChatCliForkIdentity
} from './tab-session-history-switch'
import { translate } from '@/i18n/i18n'

const pending = new Map<string, AbortController>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
type PendingIdentity = Pick<NativeChatCliForkIdentity, 'executionHostScope' | 'sessionId'>
const keyFor = (subject: PendingIdentity) => `${subject.executionHostScope}\0${subject.sessionId}`
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useNativeChatCliForkPending(subject: PendingIdentity | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!subject && pending.has(keyFor(subject)),
    () => false
  )
}

export async function runNativeChatCliFork(args: {
  subject: NativeChatCliForkSubject
  tab: { id: string; worktreeId: string }
  agent: AiVaultAgent
  onComplete?: () => void
  commandOverrides?: Partial<Record<AiVaultAgent, string | null>>
}): Promise<void> {
  const { subject, tab } = args
  const key = keyFor({ ...subject, executionHostScope: subject.request.executionHostScope })
  if (pending.has(key)) {
    return
  }
  const host = parseExecutionHostId(subject.request.executionHostScope)
  const owner = host?.kind === 'runtime' ? captureWebSessionIntentOwner(host.environmentId) : null
  const controller = new AbortController()
  const isCurrent = () => {
    if (controller.signal.aborted || (owner && !matchesWebSessionIntentOwner(owner))) {
      return false
    }
    const state = useAppStore.getState()
    const source = state.unifiedTabsByWorktree[tab.worktreeId]?.find((item) => item.id === tab.id)
    const current =
      source?.contentType === 'agent-session' && source.entityId === subject.sessionId
        ? resolveNativeChatCliForkIdentity(state, {
            tab,
            nativeChat: { sessionId: subject.sessionId, agent: args.agent }
          })
        : null
    return current?.executionHostScope === subject.request.executionHostScope
  }
  if (!isCurrent()) {
    return
  }
  const release = () => {
    if (pending.get(key) === controller) {
      pending.delete(key)
      changed()
    }
  }
  const abandon = () => {
    controller.abort()
    release()
  }
  pending.set(key, controller)
  changed()
  const stopSource = useAppStore.subscribe(() => {
    if (!isCurrent()) {
      abandon()
    }
  })
  const retire = (ids: readonly string[]) => {
    if (owner && ids.includes(owner.environmentId)) {
      abandon()
    }
  }
  const stopRetirement = onRuntimeEnvironmentsRetired(retire)
  const stopRevision = onRuntimeEnvironmentRevisionsChanged(retire)
  const stop = () => {
    stopSource()
    stopRetirement()
    stopRevision()
  }
  try {
    const prepared = await prepareNativeChatCliFork(subject, {
      pairingRevision: owner?.pairingRevision,
      isCurrent,
      signal: controller.signal
    })
    if (!isCurrent()) {
      return
    }
    const target = prepared.session
    const startupArgs = {
      state: useAppStore.getState(),
      worktreeId: subject.workspaceId,
      session: target,
      commandOverride: args.commandOverrides?.[target.agent]
    }
    assertAiVaultCopiedSessionLaunchAllowed(startupArgs)
    const startup = prepared.copied
      ? buildAiVaultCopiedSessionStartupForWorktree(startupArgs, prepared.sourceAgent ?? args.agent)
      : buildAiVaultForkStartupForWorktree(startupArgs)
    if (!startup) {
      throw new Error(
        translate(
          'auto.components.tab.bar.nativeChatCliFork.cannotOpenInCli',
          'This session cannot be opened in the CLI.'
        )
      )
    }
    // The destination takes over synchronously; closing the source afterward must not cancel it.
    if (!isCurrent()) {
      return
    }
    stop()
    await launchAiVaultSessionAndReveal(
      { agent: target.agent, worktreeId: subject.workspaceId, ...startup },
      describeAiVaultCliForkFailure
    )
  } catch (error) {
    if (pending.get(key) === controller) {
      notifyAiVaultSessionPreparationFailure(
        new Error(readIpcErrorMessage(error)),
        args.agent,
        describeAiVaultCliForkFailure
      )
    }
  } finally {
    stop()
    release()
    args.onComplete?.()
  }
}
