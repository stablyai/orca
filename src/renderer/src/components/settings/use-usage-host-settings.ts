import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  composeUsageRequestPolicyEnabled,
  type UsageRequestProvider
} from '../../../../shared/usage-request-policy'

export type UsageHostSettings = Partial<
  Pick<
    GlobalSettings,
    'minimaxEndpoint' | 'minimaxGroupId' | 'minimaxUsageModels' | 'zcodePlanSite'
  >
>

type HostSettingsProjection = Partial<GlobalSettings> & {
  usageRequestPolicyVersion?: number
  antigravityUsageEnabled?: boolean
}

type RequestPolicy = {
  access: 'checking' | 'ready' | 'outdated' | 'unreachable'
  enabled: Record<UsageRequestProvider, boolean> | null
  pending: boolean
  update: (provider: UsageRequestProvider, enabled: boolean) => Promise<void>
}

export type UsageHostSettingsModel = {
  settings: UsageHostSettings | null
  update: (updates: UsageHostSettings) => Promise<void>
  requestPolicy?: RequestPolicy
}

function supportsRequestPolicy(
  settings: HostSettingsProjection | null | undefined
): settings is HostSettingsProjection {
  const map = settings?.usageRequestEnabled
  return (
    settings?.usageRequestPolicyVersion === 1 &&
    typeof settings.antigravityUsageEnabled === 'boolean' &&
    typeof map === 'object' &&
    map !== null &&
    !Array.isArray(map) &&
    Object.values(map).every((value) => typeof value === 'boolean')
  )
}

function pickUsageHostSettings(settings: Partial<GlobalSettings>): UsageHostSettings {
  return {
    minimaxEndpoint: settings.minimaxEndpoint,
    minimaxGroupId: settings.minimaxGroupId,
    minimaxUsageModels: settings.minimaxUsageModels,
    zcodePlanSite: settings.zcodePlanSite
  }
}

export function useUsageHostSettings(
  owner: RuntimeClientTarget,
  hostLabel: string | null,
  localSettings: GlobalSettings,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void,
  policyRevision?: number,
  ownerUnreachable = false
): UsageHostSettingsModel {
  const ownerEnvironmentId = owner.kind === 'environment' ? owner.environmentId : null
  const ownerKey = ownerEnvironmentId ?? 'local'
  const ownerEpoch = useMemo(() => ({ key: ownerKey }), [ownerKey])
  const currentOwner = useRef(ownerEpoch)
  useLayoutEffect(() => {
    currentOwner.current = ownerEpoch
  }, [ownerEpoch])
  const localPolicyRevision = useAppStore((s) => s.rateLimits?.usageRequestPolicy?.revision)
  const refreshLocalSettings = useAppStore((s) => s.fetchSettings)
  const hydratePersistedUI = useAppStore((s) => s.hydratePersistedUI)
  const selectedPolicyRevision = ownerEnvironmentId ? policyRevision : localPolicyRevision
  const writeSerial = useRef(0)
  const readSerial = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [remote, setRemote] = useState<{
    ownerKey: string
    settings: HostSettingsProjection | null
    access: RequestPolicy['access']
  } | null>(null)
  const [pendingOwner, setPendingOwner] = useState<string | null>(null)
  const writes = useRef(new Set<string>())

  useEffect(() => {
    if (ownerUnreachable) {
      return
    }
    const revision = writeSerial.current
    const read = ++readSerial.current
    let current = true
    void callRuntimeRpc<{ settings: HostSettingsProjection }>(
      ownerEnvironmentId
        ? { kind: 'environment', environmentId: ownerEnvironmentId }
        : { kind: 'local' },
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    ).then(
      (result) => {
        const settings = result?.settings ?? null
        if (current && revision === writeSerial.current && read === readSerial.current) {
          setRemote({
            ownerKey,
            settings,
            access: supportsRequestPolicy(settings) ? 'ready' : 'outdated'
          })
        }
      },
      () => {
        if (current && revision === writeSerial.current && read === readSerial.current) {
          setRemote({ ownerKey, settings: null, access: 'unreachable' })
        }
      }
    )
    return () => {
      current = false
    }
  }, [ownerEnvironmentId, ownerKey, selectedPolicyRevision, ownerUnreachable])

  const selectedRemote = remote?.ownerKey === ownerKey ? remote : null
  const access = ownerUnreachable ? 'unreachable' : (selectedRemote?.access ?? 'checking')
  const hostSettings = ownerEnvironmentId ? (selectedRemote?.settings ?? null) : localSettings
  const enabled =
    access === 'ready' && selectedRemote?.settings
      ? composeUsageRequestPolicyEnabled(
          selectedRemote.settings.usageRequestEnabled,
          selectedRemote.settings.antigravityUsageEnabled === true
        )
      : null
  const reportError = (error: unknown): void => {
    if (!mounted.current || currentOwner.current !== ownerEpoch) {
      return
    }
    toast.error(
      translate(
        'auto.components.settings.useUsageHostSettings.updateFailed',
        'Could not update the setting on {{host}}.',
        {
          host: hostLabel ?? translate('settings.usageRequests.localHost', 'this computer')
        }
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
  }

  return {
    settings: hostSettings ? pickUsageHostSettings(hostSettings) : null,
    update: async (updates) => {
      try {
        if (!ownerEnvironmentId) {
          await updateLocalSettings(updates)
          return
        }
        const result = await callRuntimeRpc<{ settings: HostSettingsProjection }>(
          owner,
          'settings.update',
          updates,
          { timeoutMs: 15_000 }
        )
        if (mounted.current && currentOwner.current === ownerEpoch) {
          setRemote((previous) =>
            previous?.ownerKey === ownerKey
              ? {
                  ...previous,
                  settings: { ...previous.settings, ...pickUsageHostSettings(result.settings) }
                }
              : previous
          )
        }
      } catch (error) {
        reportError(error)
      }
    },
    requestPolicy: {
      access,
      enabled,
      pending: pendingOwner === ownerKey,
      update: async (provider, value) => {
        if (access !== 'ready' || !enabled || writes.current.has(ownerKey)) {
          return
        }
        writes.current.add(ownerKey)
        setPendingOwner(ownerKey)
        let confirmedReadback = false
        let reconciliationRead: number | undefined
        try {
          writeSerial.current += 1
          const precedingRead = readSerial.current
          const updates =
            provider === 'antigravity'
              ? { antigravityUsageEnabled: value }
              : { usageRequestEnabled: { [provider]: value } }
          const result = await callRuntimeRpc<{ settings: HostSettingsProjection }>(
            owner,
            'settings.update',
            updates,
            { timeoutMs: 15_000 }
          )
          if (currentOwner.current === ownerEpoch) {
            writeSerial.current += 1
          }
          let readback = result?.settings ?? null
          if (!supportsRequestPolicy(readback)) {
            confirmedReadback = true
            if (mounted.current && currentOwner.current === ownerEpoch) {
              setRemote({ ownerKey, settings: readback, access: 'outdated' })
            }
            throw new Error('Update Orca on this host to control usage requests.')
          }
          confirmedReadback = true
          const applied =
            provider === 'antigravity'
              ? readback.antigravityUsageEnabled === true
              : readback.usageRequestEnabled?.[provider] !== false
          if (applied !== value) {
            throw new Error('The host did not confirm this usage request setting.')
          }
          if (readSerial.current !== precedingRead && currentOwner.current === ownerEpoch) {
            confirmedReadback = false
            const read = ++readSerial.current
            reconciliationRead = read
            setRemote({ ownerKey, settings: null, access: 'checking' })
            const latest = await callRuntimeRpc<{ settings: HostSettingsProjection }>(
              owner,
              'settings.get',
              undefined,
              { timeoutMs: 15_000 }
            )
            if (read !== readSerial.current) {
              return
            }
            readback = latest?.settings ?? null
            if (!supportsRequestPolicy(readback)) {
              throw new Error('Update Orca on this host to control usage requests.')
            }
            confirmedReadback = true
          }
          if (mounted.current && currentOwner.current === ownerEpoch) {
            setRemote({ ownerKey, settings: readback, access: 'ready' })
            if (!ownerEnvironmentId) {
              if (provider === 'antigravity') {
                const ui = await window.api.ui.get()
                if (mounted.current && currentOwner.current === ownerEpoch) {
                  hydratePersistedUI(ui)
                }
              } else {
                await refreshLocalSettings()
              }
            }
          }
        } catch (error) {
          if (reconciliationRead !== undefined && reconciliationRead !== readSerial.current) {
            return
          }
          if (!confirmedReadback && mounted.current && currentOwner.current === ownerEpoch) {
            writeSerial.current += 1
            setRemote((previous) => ({
              ownerKey,
              settings: previous?.ownerKey === ownerKey ? previous.settings : null,
              access: 'unreachable'
            }))
          }
          reportError(error)
        } finally {
          writes.current.delete(ownerKey)
          setPendingOwner((pending) => (pending === ownerKey ? null : pending))
        }
      }
    }
  }
}
