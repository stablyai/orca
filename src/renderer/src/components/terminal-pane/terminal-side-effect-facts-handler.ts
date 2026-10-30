import type { RuntimeClientEventInstallation } from '@/runtime/runtime-client-events'
import { createTerminalResidentSourceAdmissions } from './terminal-resident-source-admission'
import { captureTerminalFactSubject } from './terminal-fact-subject'
import {
  openHandoffFactBuffer,
  bufferHandoffFactBatch,
  drainHandoffFactBuffer,
  resetHandoffFacts
} from './terminal-handoff-facts'
import { resetTerminalSideEffectAuthorityForTest } from './terminal-side-effect-authority'
export { isMainTerminalSideEffectAuthorityForPty } from './terminal-side-effect-authority'
import {
  attachResidentConsumer,
  type ConsumerEntry,
  type TerminalSideEffectFactConsumerOptions
} from './terminal-side-effect-consumer'
export type {
  TerminalSideEffectFactConsumerCallbacks,
  TerminalSideEffectFactConsumerOptions
} from './terminal-side-effect-consumer'
import { useAppStore } from '@/store'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { deferPtyShutdownExit } from './pty-shutdown-exit-deferral'
import { createTerminalResidentPolicy } from './terminal-resident-policy'
import { resolveTerminalResidentBinding } from './terminal-resident-binding'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'

import {
  sourceSubscriptionsByPtyId,
  residentRegistry,
  residentsByPtyId,
  legacySourcesByPtyId,
  disposeLegacySource,
  retireCapturedResident
} from './terminal-semantic-residents'
export {
  getTerminalSemanticResident,
  retireTerminalSemanticResident,
  retireTerminalSemanticResidentsForTab,
  type TerminalSemanticResident
} from './terminal-semantic-residents'

const {
  admitLegacyTerminalSemanticResident,
  followLocalTerminalSemanticSource,
  admitRemoteTerminalSemanticResident,
  installTerminalSideEffectSource,
  qualifyTerminalSideEffectSource
} = createTerminalResidentSourceAdmissions((ptyId, resident) => {
  for (const entry of consumersByPtyId.get(ptyId) ?? []) {
    attachResidentConsumer(entry, resident)
  }
})
export {
  admitLegacyTerminalSemanticResident,
  followLocalTerminalSemanticSource,
  admitRemoteTerminalSemanticResident,
  installTerminalSideEffectSource
}

export function observeTerminalSemanticResidentExit(
  ptyId: string,
  code: number,
  incarnationId?: string
): void {
  const resident = residentsByPtyId.get(ptyId)
  if (
    !resident ||
    (incarnationId !== undefined && resident.identity.incarnationId !== incarnationId)
  ) {
    return
  }
  if (!isProvenProcessExit(code)) {
    resident.policy.foreground.paneForegroundAgentTracker.suspend()
    return
  }
  if (useAppStore.getState().isPtyShutdownPending(ptyId)) {
    deferPtyShutdownExit(ptyId, (settlement) => {
      if (settlement === 'committed') {
        retireCapturedResident(resident)
      }
    })
    return
  }
  retireCapturedResident(resident)
}

import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'

const consumersByPtyId = new Map<string, Set<ConsumerEntry>>()
let channelUnsubscribe: (() => void) | null = null

export function dispatchTerminalSideEffectBatch(
  batch: TerminalSideEffectBatch,
  installation?: RuntimeClientEventInstallation
): void {
  if (!qualifyTerminalSideEffectSource(batch, installation?.source)) {
    return
  }
  const entries = consumersByPtyId.get(batch.ptyId)
  const entry = entries?.values().next().value
  const binding = entry?.binding ?? sourceSubscriptionsByPtyId.get(batch.ptyId)?.binding
  const attribution = batch.paneKey && batch.tabId && batch.worktreeId ? batch : binding
  const paneKey = attribution?.paneKey
  const tabId = attribution?.tabId
  const worktreeId = attribution?.worktreeId
  if (
    !batch.terminalState &&
    !parseRemoteRuntimePtyId(batch.ptyId) &&
    legacySourcesByPtyId.get(batch.ptyId)?.source.byteSource
  ) {
    return
  }
  if (batch.terminalState && paneKey && tabId && worktreeId) {
    const paired = parseRemoteRuntimePtyId(batch.ptyId)
    const identity = {
      endpoint: paired?.environmentId ?? 'local',
      executionHost: batch.connectionId
        ? toSshExecutionHostId(batch.connectionId)
        : (getPtyExecutionHost(batch.ptyId) ?? 'local'),
      ptyId: batch.ptyId,
      runtimeId: batch.terminalState.runtimeId,
      incarnationId: batch.terminalState.incarnationId
    }
    const resident = residentRegistry.admit(identity, (captured) =>
      createTerminalResidentPolicy(
        resolveTerminalResidentBinding({
          ...batch,
          paneKey,
          tabId,
          worktreeId,
          binding
        }),
        captured.identity,
        () => captured.isLive,
        entry?.services
      )
    )
    if (!resident.admitIdentity(identity)) {
      return
    }
    resident.policy.bindPty(identity.ptyId, identity.incarnationId, identity.runtimeId)
    drainHandoffFactBuffer(batch.ptyId, resident)
    disposeLegacySource(batch.ptyId)
    sourceSubscriptionsByPtyId.get(batch.ptyId)?.close?.()
    sourceSubscriptionsByPtyId.delete(batch.ptyId)
    residentsByPtyId.set(batch.ptyId, resident)
    for (const consumer of entries ?? []) {
      attachResidentConsumer(consumer, resident)
    }
    resident.consume(batch)
    return
  }
  const resident = residentsByPtyId.get(batch.ptyId)
  if (resident) {
    if (batch.terminalState) {
      if (
        resident.admitIdentity({
          ...resident.identity,
          runtimeId: batch.terminalState.runtimeId,
          incarnationId: batch.terminalState.incarnationId
        })
      ) {
        resident.policy.bindPty(
          batch.ptyId,
          batch.terminalState.incarnationId,
          batch.terminalState.runtimeId
        )
        disposeLegacySource(batch.ptyId)
        sourceSubscriptionsByPtyId.get(batch.ptyId)?.close?.()
        sourceSubscriptionsByPtyId.delete(batch.ptyId)
        resident.consume(batch)
      }
    } else if (
      resident.identity.runtimeId === null ||
      (installation?.source &&
        legacySourcesByPtyId.get(batch.ptyId)?.installationSource === installation.source)
    ) {
      resident.policy.legacySource.observeFacts(batch)
    }
    return
  }
  bufferHandoffFactBatch(batch)
}

function ensureSideEffectChannelSubscription(): void {
  if (channelUnsubscribe !== null) {
    return
  }
  // Why: optional-chained from globalThis so unit tests (and any non-preload
  // surface) without window.api degrade to "no channel" instead of throwing.
  const onSideEffect = (globalThis as { window?: Window }).window?.api?.pty?.onSideEffect
  if (typeof onSideEffect !== 'function') {
    return
  }
  channelUnsubscribe = onSideEffect(dispatchTerminalSideEffectBatch)
}

/** Presentation registrations attach to the source-selected execution; they never construct policy. */
export function registerTerminalSideEffectFactConsumer(
  options: TerminalSideEffectFactConsumerOptions
): () => void {
  ensureSideEffectChannelSubscription()
  const entry: ConsumerEntry = {
    binding: options.binding,
    services: options.services,
    onResident: (captured) => {
      const detach = options.onResident(captured)
      if (options.restoreTitleOnRegister) {
        const getSnapshot = globalThis.window?.api?.pty?.getSideEffectSnapshot
        const subject = captureTerminalFactSubject(entry.binding.paneKey)
        if (typeof getSnapshot === 'function') {
          void getSnapshot(options.ptyId)
            .then((batch) => {
              if (
                !batch ||
                !captured.isLive ||
                !entries.has(entry) ||
                entry.resident !== captured
              ) {
                return
              }
              if (batch.terminalState) {
                captured.consume({ ...batch, replay: true }, subject)
              } else {
                captured.policy.legacySource.observeFacts({ ...batch, replay: true }, subject)
              }
            })
            .catch(() => {})
        }
      }
      return detach
    }
  }
  let entries = consumersByPtyId.get(options.ptyId)
  if (!entries) {
    entries = new Set()
    consumersByPtyId.set(options.ptyId, entries)
  }
  entries.add(entry)
  const resident = residentsByPtyId.get(options.ptyId)
  if (resident) {
    attachResidentConsumer(entry, resident)
  } else {
    openHandoffFactBuffer(options.ptyId, entry.binding, true)
  }

  return () => {
    if (!entries.delete(entry)) {
      return
    }
    entry.detachPresentation?.()
    if (entries.size === 0 && consumersByPtyId.get(options.ptyId) === entries) {
      consumersByPtyId.delete(options.ptyId)
      if (!residentsByPtyId.has(options.ptyId)) {
        openHandoffFactBuffer(options.ptyId, entry.binding)
      }
    }
  }
}

/** Test seam: deliver a batch as if it arrived on the channel. */
export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  dispatchTerminalSideEffectBatch(batch)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalSideEffectFactConsumersForTest(): void {
  for (const entries of consumersByPtyId.values()) {
    for (const entry of entries) {
      entry.detachPresentation?.()
    }
  }
  consumersByPtyId.clear()
  resetHandoffFacts()
  residentRegistry.dispose()
  for (const source of sourceSubscriptionsByPtyId.values()) {
    source.close?.()
  }
  sourceSubscriptionsByPtyId.clear()
  residentsByPtyId.clear()
  for (const ptyId of legacySourcesByPtyId.keys()) {
    disposeLegacySource(ptyId)
  }
  channelUnsubscribe?.()
  channelUnsubscribe = null
  resetTerminalSideEffectAuthorityForTest()
}
