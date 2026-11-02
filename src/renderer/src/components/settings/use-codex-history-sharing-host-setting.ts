import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getCodexHistorySharingUpdateFailed } from './codex-history-sharing-copy'

/** `unsupported`: an older host that neither reports nor accepts the setting. */
export type CodexHistorySharingHostSetting =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; enabled: boolean }

type HostSettings = { settings: Partial<GlobalSettings> }

function readHostSetting(settings: Partial<GlobalSettings>): CodexHistorySharingHostSetting {
  // Newer hosts always report the key; its absence means the host would reject an update.
  return typeof settings.codexShareHistoryAcrossAccounts === 'boolean'
    ? { state: 'ready', enabled: settings.codexShareHistoryAcrossAccounts }
    : { state: 'unsupported' }
}

/** The host that launches Codex owns its history links, so the switch reads and writes that host. */
export function useCodexHistorySharingHostSetting(
  owner: RuntimeClientTarget,
  hostLabel: string,
  localSettings: GlobalSettings,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
): { setting: CodexHistorySharingHostSetting; update: (enabled: boolean) => Promise<void> } {
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const [remote, setRemote] = useState<{
    environmentId: string
    setting: CodexHistorySharingHostSetting
  } | null>(null)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    void callRuntimeRpc<HostSettings>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    ).then(
      (result) => {
        if (current) {
          setRemote({ environmentId, setting: readHostSetting(result.settings) })
        }
      },
      (error: unknown) => console.error('Failed to load the host Codex history setting:', error)
    )
    return () => {
      current = false
    }
  }, [environmentId])

  if (!environmentId) {
    return {
      setting: { state: 'ready', enabled: localSettings.codexShareHistoryAcrossAccounts !== false },
      update: async (enabled) => {
        await updateLocalSettings({ codexShareHistoryAcrossAccounts: enabled })
      }
    }
  }
  return {
    setting: remote?.environmentId === environmentId ? remote.setting : { state: 'loading' },
    update: async (enabled) => {
      try {
        const result = await callRuntimeRpc<HostSettings>(
          { kind: 'environment', environmentId },
          'settings.update',
          { codexShareHistoryAcrossAccounts: enabled },
          { timeoutMs: 15_000 }
        )
        setRemote({ environmentId, setting: readHostSetting(result.settings) })
      } catch (error) {
        toast.error(getCodexHistorySharingUpdateFailed(hostLabel), {
          description: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
