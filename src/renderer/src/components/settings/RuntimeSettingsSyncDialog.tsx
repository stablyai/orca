import { useEffect, useMemo, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type { PortableSettingsSyncState } from '../../../../shared/portable-settings-sync'
import {
  getPortableSettingsCategoryDifferences,
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsBundle,
  type PortableSettingsCategory
} from '../../../../shared/portable-settings'
import {
  AGENTS_CLI_INSTALL_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { toAgentInstallPlatform } from '../../../../shared/tui-agent-install-commands'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import {
  RuntimeSettingsSyncCategoryList,
  type RuntimeSettingsSyncCategoryPreview
} from './RuntimeSettingsSyncCategoryList'
import { RuntimeSettingsSyncModeControl } from './RuntimeSettingsSyncModeControl'
import { RuntimeSettingsSyncAgentsSection } from './RuntimeSettingsSyncAgentsSection'
import { installMissingAgentsOnRuntime } from './runtime-settings-sync-agent-install'
import {
  formatRuntimeSettingsSyncLoadError,
  loadRuntimeSettingsSyncDialogState
} from './runtime-settings-sync-dialog-load'

type PortableSettingsApplyResult = {
  bundle: PortableSettingsBundle
  appliedCategories: PortableSettingsCategory[]
}

const EMPTY_CAPABILITIES: readonly RuntimeCapability[] = []

export function RuntimeSettingsSyncDialog({
  environmentId,
  environmentName,
  settings,
  syncState,
  allowContinuousSync = true,
  hostPlatform = null,
  capabilities = EMPTY_CAPABILITIES,
  onClose
}: {
  environmentId: string
  environmentName: string
  settings: GlobalSettings
  syncState: PortableSettingsSyncState | null
  allowContinuousSync?: boolean
  hostPlatform?: NodeJS.Platform | null
  capabilities?: readonly RuntimeCapability[]
  onClose: () => void
}): React.JSX.Element {
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const ensureRuntimeDetectedAgents = useAppStore((s) => s.ensureRuntimeDetectedAgents)
  const clearRuntimeDetectedAgents = useAppStore((s) => s.clearRuntimeDetectedAgents)

  const [localBundle, setLocalBundle] = useState<PortableSettingsBundle | null>(null)
  const [remoteBundle, setRemoteBundle] = useState<PortableSettingsBundle | null>(null)
  const [selected, setSelected] = useState<PortableSettingsCategory[]>(
    syncState?.categories ?? [...PORTABLE_SETTINGS_CATEGORIES]
  )
  const [keepInSync, setKeepInSync] = useState(syncState?.enabled ?? false)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [installableAgents, setInstallableAgents] = useState<TuiAgent[]>([])
  const [manualOnlyAgents, setManualOnlyAgents] = useState<TuiAgent[]>([])
  const [installAgentsEnabled, setInstallAgentsEnabled] = useState(false)
  const [selectedInstallAgents, setSelectedInstallAgents] = useState<TuiAgent[]>([])
  const [installProgress, setInstallProgress] = useState<string | null>(null)
  const supportsAgentInstall = capabilities.includes(AGENTS_CLI_INSTALL_RUNTIME_CAPABILITY)
  const installPlatform = toAgentInstallPlatform(hostPlatform ?? 'linux')
  const syncCategoriesKey = syncState?.categories.join('\0') ?? ''
  const configuredCategories = useMemo(
    () =>
      syncCategoriesKey
        ? (syncCategoriesKey.split('\0') as PortableSettingsCategory[])
        : [...PORTABLE_SETTINGS_CATEGORIES],
    [syncCategoriesKey]
  )

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const loaded = await loadRuntimeSettingsSyncDialogState({
          environmentId,
          settings,
          configuredCategories,
          supportsAgentInstall,
          installPlatform,
          ensureDetectedAgents,
          ensureRuntimeDetectedAgents
        })
        if (cancelled) {
          return
        }
        setLocalBundle(loaded.localBundle)
        setRemoteBundle(loaded.remoteBundle)
        setSelected(loaded.selected)
        setInstallableAgents(loaded.installable)
        setManualOnlyAgents(loaded.manualOnly)
        setSelectedInstallAgents(loaded.installable)
        setInstallAgentsEnabled(loaded.installable.length > 0)
      } catch (loadError) {
        if (!cancelled) {
          setError(formatRuntimeSettingsSyncLoadError(loadError))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [
    configuredCategories,
    ensureDetectedAgents,
    ensureRuntimeDetectedAgents,
    environmentId,
    installPlatform,
    reloadToken,
    settings,
    supportsAgentInstall
  ])

  const previews = useMemo<RuntimeSettingsSyncCategoryPreview[]>(
    () =>
      localBundle && remoteBundle
        ? PORTABLE_SETTINGS_CATEGORIES.map((category) => ({
            category,
            differences: getPortableSettingsCategoryDifferences(localBundle, remoteBundle, category)
          }))
        : [],
    [localBundle, remoteBundle]
  )

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedInstallSet = useMemo(() => new Set(selectedInstallAgents), [selectedInstallAgents])

  const stopSyncing = async (): Promise<void> => {
    if (applying) {
      return
    }
    setApplying(true)
    setError(null)
    try {
      await window.api.portableSettingsSync.stop({ environmentId })
      toast.success(
        translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.syncStopped',
          'Stopped settings sync to {{value0}}.',
          { value0: environmentName }
        )
      )
      onClose()
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
    } finally {
      setApplying(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!localBundle || selected.length === 0 || applying) {
      return
    }
    setApplying(true)
    setError(null)
    let settingsOk = false
    try {
      if (keepInSync) {
        await window.api.portableSettingsSync.configure({
          environmentId,
          categories: selected,
          enabled: true
        })
        toast.success(
          translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.syncStarted',
            'Settings will stay synced to {{value0}}.',
            { value0: environmentName }
          )
        )
        settingsOk = true
      } else {
        if (syncState) {
          await window.api.portableSettingsSync.configure({
            environmentId,
            categories: selected,
            enabled: false
          })
        }
        await callRuntimeRpc<PortableSettingsApplyResult>(
          { kind: 'environment', environmentId },
          'settings.portable.apply',
          { categories: selected, bundle: localBundle },
          { timeoutMs: 15_000 }
        )
        toast.success(
          translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.success',
            'Synced settings to {{value0}}.',
            { value0: environmentName }
          )
        )
        settingsOk = true
      }
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : translate(
              'auto.components.settings.RuntimeSettingsSyncDialog.applyFailed',
              'Could not sync settings to this server.'
            )
      )
    }

    // Why: installs are independent of preference sync — a settings failure
    // should not block provisioning CLIs, and install failures must not roll
    // back settings that already applied.
    if (supportsAgentInstall && installAgentsEnabled && selectedInstallAgents.length > 0) {
      setInstallProgress(
        translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.installingAgents',
          'Installing missing agent CLIs…'
        )
      )
      await installMissingAgentsOnRuntime({
        environmentId,
        environmentName,
        agents: selectedInstallAgents,
        clearRuntimeDetectedAgents,
        ensureRuntimeDetectedAgents,
        onSuccess: (message) => toast.success(message),
        onError: (message) => toast.error(message)
      })
      setInstallProgress(null)
    }

    if (settingsOk) {
      onClose()
    } else {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && !applying && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.RuntimeSettingsSyncDialog.title',
              'Sync settings to {{value0}}',
              { value0: environmentName }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.RuntimeSettingsSyncDialog.description',
              'Choose which preferences this Orca should send to the linked server.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              {translate(
                'auto.components.settings.RuntimeSettingsSyncDialog.security',
                'Accounts, credentials, secrets, machine paths, histories, and integration sessions are never included.'
              )}
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.components.settings.RuntimeSettingsSyncDialog.comparing',
              'Comparing settings…'
            )}
          </div>
        ) : error && previews.length === 0 ? (
          <div className="flex min-h-24 items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <span>{error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              {translate('auto.components.settings.RuntimeSettingsSyncDialog.retry', 'Try again')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <RuntimeSettingsSyncCategoryList
              previews={previews}
              selected={selectedSet}
              applying={applying}
              onSelectedChange={(category, checked) =>
                setSelected((current) =>
                  checked
                    ? Array.from(new Set([...current, category]))
                    : current.filter((entry) => entry !== category)
                )
              }
            />
            {supportsAgentInstall ? (
              <RuntimeSettingsSyncAgentsSection
                installable={installableAgents}
                manualOnly={manualOnlyAgents}
                selected={selectedInstallSet}
                enabled={installAgentsEnabled}
                applying={applying}
                onEnabledChange={setInstallAgentsEnabled}
                onSelectedChange={(agent, checked) =>
                  setSelectedInstallAgents((current) =>
                    checked
                      ? Array.from(new Set([...current, agent]))
                      : current.filter((entry) => entry !== agent)
                  )
                }
              />
            ) : null}
          </div>
        )}

        {error && previews.length > 0 ? <p className="text-sm text-destructive">{error}</p> : null}
        {installProgress ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {installProgress}
          </p>
        ) : null}

        {!loading && previews.length > 0 && allowContinuousSync ? (
          <RuntimeSettingsSyncModeControl
            checked={keepInSync}
            disabled={applying}
            onChange={() => setKeepInSync((current) => !current)}
          />
        ) : null}

        <DialogFooter className="sm:justify-between">
          <div>
            {syncState ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={applying}
                onClick={() => void stopSyncing()}
              >
                {translate(
                  'auto.components.settings.RuntimeSettingsSyncDialog.stopSyncing',
                  'Stop syncing'
                )}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={applying}>
              {translate('auto.components.settings.RuntimeSettingsSyncDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void apply()}
              disabled={loading || applying || selected.length === 0}
            >
              {applying ? <Loader2 className="animate-spin" /> : null}
              {keepInSync && !syncState?.enabled
                ? translate(
                    'auto.components.settings.RuntimeSettingsSyncDialog.startSyncing',
                    'Start syncing'
                  )
                : translate(
                    'auto.components.settings.RuntimeSettingsSyncDialog.syncNow',
                    'Sync now'
                  )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
