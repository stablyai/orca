import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import { createTerminalResidentPolicy } from './terminal-resident-policy'
import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-policy'
import { subscribeToPtyData } from './pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData, hasPreHandlerPtyExit } from './pty-pre-handler-buffer'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { subscribeResidentRemoteSource } from './terminal-resident-remote-source'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import { drainHandoffFactBuffer } from './terminal-handoff-facts'
import {
  sourceSubscriptionsByPtyId,
  residentRegistry,
  residentsByPtyId,
  legacySourcesByPtyId,
  disposeLegacySource,
  retireCapturedResident,
  type TerminalSemanticResident
} from './terminal-semantic-residents'

export function createTerminalResidentSourceAdmissions(
  onAdmitted: (ptyId: string, resident: TerminalSemanticResident) => void
) {
  function admitLegacyTerminalSemanticResident(options: {
    ptyId: string
    incarnationId?: string | null
    binding: TerminalResidentBinding
    byteSource: boolean
    services?: TerminalResidentServices
    selectLegacy?: boolean
    installationSource?: object
  }): TerminalSemanticResident {
    let existing = residentsByPtyId.get(options.ptyId)
    if (
      existing?.identity.incarnationId &&
      options.incarnationId &&
      existing.identity.incarnationId !== options.incarnationId
    ) {
      retireCapturedResident(existing)
      existing = undefined
    }
    const sameExecution =
      existing &&
      (!options.incarnationId || existing.identity.incarnationId === options.incarnationId)
        ? existing
        : undefined
    if (sameExecution && sameExecution.identity.runtimeId !== null && !options.selectLegacy) {
      return sameExecution
    }
    const paired = parseRemoteRuntimePtyId(options.ptyId)
    const identity = {
      endpoint: paired?.environmentId ?? 'local',
      executionHost:
        options.binding.workspaceOwner?.executionHostId ??
        getPtyExecutionHost(options.ptyId) ??
        'local',
      runtimeId: null,
      ptyId: options.ptyId,
      incarnationId: options.incarnationId ?? null
    }
    const resident = sameExecution
      ? sameExecution
      : residentRegistry.admit(identity, (captured) =>
          createTerminalResidentPolicy(
            options.binding,
            captured.identity,
            () => captured.isLive,
            options.services
          )
        )
    resident.policy.bindPty(identity.ptyId, identity.incarnationId)
    residentsByPtyId.set(options.ptyId, resident)
    if (!sameExecution || options.selectLegacy) {
      resident.policy.legacySource.byteSource = options.byteSource
    }
    drainHandoffFactBuffer(options.ptyId, resident)
    let legacy = legacySourcesByPtyId.get(options.ptyId)
    if (!legacy || legacy.resident !== resident) {
      disposeLegacySource(options.ptyId)
      legacy = { resident, source: resident.policy.legacySource }
      legacySourcesByPtyId.set(options.ptyId, legacy)
    }
    if (options.installationSource) {
      legacy.installationSource = options.installationSource
    }
    if (options.byteSource && !legacy.unsubscribe) {
      legacy.unsubscribe = paired
        ? undefined
        : subscribeToPtyData(options.ptyId, (data, meta) => {
            resident.policy.observeLegacyData(data, meta)
          })
      if (!paired) {
        replayPreHandlerPtyData(options.ptyId, (data, meta, subject) => {
          resident.policy.observeLegacyData(data, meta, subject ?? null)
        })
      }
    }
    onAdmitted(options.ptyId, resident)
    return resident
  }

  function followLocalTerminalSemanticSource(
    options: Parameters<typeof admitLegacyTerminalSemanticResident>[0]
  ): void {
    if (residentsByPtyId.has(options.ptyId) || sourceSubscriptionsByPtyId.has(options.ptyId)) {
      return
    }
    const hasPty = globalThis.window?.api?.pty?.hasPty
    if (typeof hasPty !== 'function') {
      return
    }
    const source = {
      tabId: options.binding.tabId,
      paneKey: options.binding.paneKey,
      binding: options.binding
    }
    sourceSubscriptionsByPtyId.set(options.ptyId, source)
    void hasPty(options.ptyId)
      .then((present) => {
        if (sourceSubscriptionsByPtyId.get(options.ptyId) !== source) {
          return
        }
        sourceSubscriptionsByPtyId.delete(options.ptyId)
        if (present === true && !hasPreHandlerPtyExit(options.ptyId)) {
          admitLegacyTerminalSemanticResident(options)
        }
      })
      .catch(() => {
        if (sourceSubscriptionsByPtyId.get(options.ptyId) === source) {
          sourceSubscriptionsByPtyId.delete(options.ptyId)
        }
      })
  }

  function admitRemoteTerminalSemanticResident(
    options: Parameters<typeof admitLegacyTerminalSemanticResident>[0]
  ): void {
    if (
      (residentsByPtyId.get(options.ptyId)?.identity.runtimeId != null &&
        !legacySourcesByPtyId.has(options.ptyId)) ||
      sourceSubscriptionsByPtyId.has(options.ptyId)
    ) {
      return
    }
    const source: {
      close?: () => void
      endpoint?: string | null
      tabId: string
      paneKey: string
      binding: TerminalResidentBinding
    } = {
      endpoint: parseRemoteRuntimePtyId(options.ptyId)?.environmentId,
      tabId: options.binding.tabId,
      paneKey: options.binding.paneKey,
      binding: options.binding
    }
    sourceSubscriptionsByPtyId.set(options.ptyId, source)
    // The named stream's actual acknowledgement admits E before its first live callback.
    source.close = subscribeResidentRemoteSource(options.ptyId, (result) =>
      admitLegacyTerminalSemanticResident({
        ...options,
        incarnationId: result?.incarnationId,
        byteSource: true,
        selectLegacy: legacySourcesByPtyId.has(options.ptyId)
      })
    )
  }

  onRuntimeEnvironmentsRetired((environmentIds) => {
    for (const [ptyId, source] of sourceSubscriptionsByPtyId) {
      if (source.endpoint && environmentIds.includes(source.endpoint)) {
        source.close?.()
        sourceSubscriptionsByPtyId.delete(ptyId)
      }
    }
    for (const resident of residentsByPtyId.values()) {
      if (environmentIds.includes(resident.identity.endpoint)) {
        retireCapturedResident(resident)
      }
    }
  })

  const pendingSourceInstallations = new WeakMap<TerminalSemanticResident, object>()

  /** Only the current endpoint subscription's positive ready may switch optional delivery. */
  function installTerminalSideEffectSource(
    endpoint: string,
    source: object,
    capable: boolean
  ): void {
    for (const [ptyId, resident] of residentsByPtyId) {
      if (resident.identity.endpoint !== endpoint) {
        continue
      }
      sourceSubscriptionsByPtyId.get(ptyId)?.close?.()
      sourceSubscriptionsByPtyId.delete(ptyId)
      disposeLegacySource(ptyId)
      pendingSourceInstallations.delete(resident)
      if (capable) {
        pendingSourceInstallations.set(resident, source)
        continue
      }
      const options = {
        ptyId,
        binding: resident.policy.binding,
        byteSource: true,
        selectLegacy: true,
        installationSource: source
      }
      admitLegacyTerminalSemanticResident(options)
      admitRemoteTerminalSemanticResident(options)
    }
  }

  function qualifyTerminalSideEffectSource(
    batch: TerminalSideEffectBatch,
    source?: object
  ): boolean {
    if (source && batch.terminalState && parseRemoteRuntimePtyId(batch.ptyId)) {
      const captured = residentsByPtyId.get(batch.ptyId)
      if (captured && pendingSourceInstallations.get(captured) === source) {
        if (!captured.installSource(batch)) {
          return false
        }
        pendingSourceInstallations.delete(captured)
      }
    }
    return true
  }

  return {
    admitLegacyTerminalSemanticResident,
    followLocalTerminalSemanticSource,
    admitRemoteTerminalSemanticResident,
    installTerminalSideEffectSource,
    qualifyTerminalSideEffectSource
  }
}
