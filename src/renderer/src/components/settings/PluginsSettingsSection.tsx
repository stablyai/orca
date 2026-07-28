import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { PluginHostInstallSource, PluginHostListEntry } from '../../../../preload/api-types'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/plugin-terminal-theme-artifact'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { usePluginTerminalThemeStore } from '@/store/plugin-terminal-themes'
import { Button } from '../ui/button'
import { PluginConsentDialog } from './PluginConsentDialog'
import { PluginInstallDialog } from './PluginInstallDialog'
import { PluginRemoveDialog } from './PluginRemoveDialog'
import { PluginRollbackDialog } from './PluginRollbackDialog'
import { PluginSettingsOverview } from './PluginSettingsOverview'
import { getPluginsSectionPresentation } from './plugins-search'
import { SettingsSection } from './SettingsSection'
import { usePluginLogs } from './use-plugin-logs'
import { usePluginMarketplaceLifecycle } from './use-plugin-marketplace-lifecycle'
import {
  activeTerminalThemeSelection,
  terminalThemeActivationUpdate
} from './plugin-terminal-theme-activation'

type PluginsSettingsSectionProps = {
  mounted: boolean
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

function errorMessage(cause: unknown, fallback: string): string {
  console.warn('[plugins] settings action failed:', cause)
  return fallback
}

export function PluginsSettingsSection({
  mounted,
  settings,
  updateSettings
}: PluginsSettingsSectionProps): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginHostListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [consentPluginId, setConsentPluginId] = useState<string | null>(null)
  const [removePluginId, setRemovePluginId] = useState<string | null>(null)
  const [busyPluginKeys, setBusyPluginKeys] = useState<Set<string>>(() => new Set())
  const [featureBusy, setFeatureBusy] = useState(false)
  const [devPathsBusy, setDevPathsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const listRequestRef = useRef(0)
  const terminalThemes = usePluginTerminalThemeStore((state) => state.themes)

  const applyPluginList = (nextPlugins: PluginHostListEntry[]): void => {
    const installedPluginKeys = new Set(nextPlugins.map((plugin) => plugin.pluginKey))
    setPlugins(nextPlugins)
    setError(null)
    // Why: accepted discovery results own installed-plugin identity and invalidate stale UI state.
    setConsentPluginId((current) => (current && installedPluginKeys.has(current) ? current : null))
    setRemovePluginId((current) => (current && installedPluginKeys.has(current) ? current : null))
    setBusyPluginKeys(
      (current) => new Set([...current].filter((pluginKey) => installedPluginKeys.has(pluginKey)))
    )
  }

  const setPluginListError = (cause: unknown): void => {
    setError(
      errorMessage(
        cause,
        translate(
          'auto.components.settings.PluginsSettingsSection.loadFailed',
          'Could not load plugins.'
        )
      )
    )
  }

  const loadPluginList = async (
    request: Promise<PluginHostListEntry[]>
  ): Promise<PluginHostListEntry[] | null> => {
    const requestId = ++listRequestRef.current
    try {
      const nextPlugins = await request
      if (!mountedRef.current || requestId !== listRequestRef.current) {
        return null
      }
      applyPluginList(nextPlugins)
      return nextPlugins
    } catch (cause) {
      if (mountedRef.current && requestId === listRequestRef.current) {
        setPluginListError(cause)
      }
      return null
    }
  }

  const applyCompletedMutation = (nextPlugins: PluginHostListEntry[]): void => {
    if (!mountedRef.current) {
      return
    }
    // Why: a mutation result is authoritative at completion time, even when an earlier action
    // finishes after a later-started action or a passive refresh is still in flight.
    listRequestRef.current += 1
    applyPluginList(nextPlugins)
  }

  useEffect(() => {
    mountedRef.current = mounted
    if (!mounted) {
      // Why: hidden lazy panes must not resurrect dialogs or unresolved async state when reopened.
      setPlugins([])
      setLoading(true)
      setError(null)
      setInstallOpen(false)
      setConsentPluginId(null)
      setRemovePluginId(null)
      setBusyPluginKeys(new Set())
      setFeatureBusy(false)
      setDevPathsBusy(false)
      setSettingsError(null)
    }
    return () => {
      mountedRef.current = false
      listRequestRef.current += 1
    }
  }, [mounted])

  useEffect(() => {
    if (!mounted || !settings.pluginSystemEnabled) {
      return
    }
    setLoading(true)
    const load = async (): Promise<void> => {
      await loadPluginList(window.api.plugins.list())
      if (mountedRef.current) {
        setLoading(false)
      }
    }
    void load()
    const unsubscribe = window.api.plugins.onChanged(() => {
      void loadPluginList(window.api.plugins.list())
    })
    return () => {
      listRequestRef.current += 1
      unsubscribe()
    }
  }, [mounted, settings.pluginSystemEnabled])

  const marketplaceLifecycle = usePluginMarketplaceLifecycle({
    mounted,
    mountedRef,
    plugins,
    applyCompletedMutation,
    setPluginListError,
    setConsentPluginId,
    setBusyPluginKeys
  })
  const pluginLogs = usePluginLogs(mounted, mountedRef, plugins)

  const sectionPresentation = getPluginsSectionPresentation()

  if (!mounted) {
    return <SettingsSection id="plugins" {...sectionPresentation} />
  }

  const selectedConsentPlugin =
    plugins.find((plugin) => plugin.pluginKey === consentPluginId) ?? null
  const consentPlugin = selectedConsentPlugin?.consentFingerprint ? selectedConsentPlugin : null
  const removePlugin = plugins.find((plugin) => plugin.pluginKey === removePluginId) ?? null
  const systemPrefersDark = getSystemPrefersDark()

  const applyTerminalTheme = async (theme: PluginTerminalThemeRegistration): Promise<void> => {
    setSettingsError(null)
    try {
      await updateSettings(terminalThemeActivationUpdate(settings, theme.id, systemPrefersDark))
    } catch {
      if (mountedRef.current) {
        setSettingsError(
          translate(
            'auto.components.settings.PluginsSettingsSection.themeApplyFailed',
            'The plugin was enabled, but Orca could not apply its terminal theme.'
          )
        )
      }
    }
  }

  const applySoleTerminalTheme = async (pluginKey: string): Promise<void> => {
    const registeredThemes = (await window.api.plugins.listTerminalThemes?.()) ?? []
    const contributedThemes = registeredThemes.filter((theme) => theme.pluginKey === pluginKey)
    if (contributedThemes.length === 1) {
      await applyTerminalTheme(contributedThemes[0]!)
    }
  }

  const toggleFeature = async (): Promise<void> => {
    setFeatureBusy(true)
    setSettingsError(null)
    setError(null)
    try {
      await updateSettings({ pluginSystemEnabled: !settings.pluginSystemEnabled })
      await loadPluginList(window.api.plugins.refresh())
    } catch {
      if (mountedRef.current) {
        setSettingsError(
          translate(
            'auto.components.settings.PluginsSettingsSection.settingsUpdateFailed',
            'Could not save plugin settings.'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setFeatureBusy(false)
      }
    }
  }

  const install = async (source: PluginHostInstallSource): Promise<void> => {
    const result = await window.api.plugins.install(source)
    if (!result.ok) {
      throw new Error(result.error)
    }
    // Why: installation is not consent; select by id and wait for the authoritative list.
    setInstallOpen(false)
    setConsentPluginId(result.pluginKey)
    await loadPluginList(window.api.plugins.refresh())
  }

  const decideConsent = async (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ): Promise<void> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    try {
      const nextPlugins = await window.api.plugins.consent({
        pluginKey,
        reviewedFingerprint,
        decision
      })
      applyCompletedMutation(nextPlugins)
      if (decision === 'approve') {
        await applySoleTerminalTheme(pluginKey)
      }
      if (mountedRef.current) {
        setConsentPluginId(null)
      }
    } finally {
      if (mountedRef.current) {
        setBusyPluginKeys((current) => {
          const next = new Set(current)
          next.delete(pluginKey)
          return next
        })
      }
    }
  }

  const toggleEnabled = async (plugin: PluginHostListEntry): Promise<void> => {
    const enabled =
      plugin.status === 'running' ||
      plugin.status === 'restarting' ||
      plugin.status === 'idle' ||
      plugin.status === 'errored'
    setBusyPluginKeys((current) => new Set(current).add(plugin.pluginKey))
    try {
      const nextEnabled = !enabled
      const nextPlugins = await window.api.plugins.setEnabled({
        pluginKey: plugin.pluginKey,
        enabled: nextEnabled
      })
      applyCompletedMutation(nextPlugins)
      if (nextEnabled) {
        await applySoleTerminalTheme(plugin.pluginKey)
      }
    } catch (cause) {
      if (mountedRef.current) {
        setPluginListError(cause)
      }
    } finally {
      if (mountedRef.current) {
        setBusyPluginKeys((current) => {
          const next = new Set(current)
          next.delete(plugin.pluginKey)
          return next
        })
      }
    }
  }

  const remove = async (pluginKey: string): Promise<void> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    try {
      const nextPlugins = await window.api.plugins.remove({ pluginKey })
      applyCompletedMutation(nextPlugins)
      if (mountedRef.current) {
        setRemovePluginId(null)
      }
    } catch (cause) {
      if (mountedRef.current) {
        setPluginListError(cause)
      }
    } finally {
      if (mountedRef.current) {
        setBusyPluginKeys((current) => {
          const next = new Set(current)
          next.delete(pluginKey)
          return next
        })
      }
    }
  }

  const refresh = async (): Promise<void> => {
    await loadPluginList(window.api.plugins.refresh())
  }

  const updateDevPaths = async (paths: string[]): Promise<void> => {
    setDevPathsBusy(true)
    setSettingsError(null)
    try {
      await updateSettings({ devPluginPaths: paths })
      await loadPluginList(window.api.plugins.refresh())
    } catch {
      const message = translate(
        'auto.components.settings.PluginsSettingsSection.settingsUpdateFailed',
        'Could not save plugin settings.'
      )
      if (mountedRef.current) {
        setSettingsError(message)
      }
      throw new Error(message)
    } finally {
      if (mountedRef.current) {
        setDevPathsBusy(false)
      }
    }
  }

  const featureEnabled = settings.pluginSystemEnabled
  return (
    <SettingsSection
      id="plugins"
      {...sectionPresentation}
      headerAction={
        <Button
          variant="outline"
          size="sm"
          disabled={!featureEnabled || featureBusy}
          onClick={() => setInstallOpen(true)}
        >
          <Plus />
          {translate('auto.components.settings.PluginsSettingsSection.install', 'Install plugin')}
        </Button>
      }
    >
      <PluginSettingsOverview
        featureEnabled={featureEnabled}
        featureBusy={featureBusy}
        settingsError={settingsError}
        loading={loading}
        error={error}
        plugins={plugins}
        terminalThemes={terminalThemes}
        activeTerminalThemeId={activeTerminalThemeSelection(settings, systemPrefersDark)}
        busyPluginKeys={busyPluginKeys}
        openLogs={pluginLogs.openLogs}
        logsByPlugin={pluginLogs.logsByPlugin}
        devPaths={settings.devPluginPaths}
        devPathsBusy={devPathsBusy}
        onToggleFeature={() => void toggleFeature()}
        onRefresh={refresh}
        onReview={setConsentPluginId}
        onToggleEnabled={(entry) => void toggleEnabled(entry)}
        onToggleLogs={pluginLogs.toggleLogs}
        onMarketplaceInstalled={marketplaceLifecycle.reloadAfterMutation}
        onRollbackRequest={marketplaceLifecycle.requestRollback}
        onRemoveRequest={setRemovePluginId}
        onApplyTerminalTheme={(theme) => void applyTerminalTheme(theme)}
        onUpdateDevPaths={updateDevPaths}
      />
      <PluginInstallDialog open={installOpen} onOpenChange={setInstallOpen} onInstall={install} />
      <PluginConsentDialog
        key={consentPlugin?.pluginKey ?? 'closed'}
        plugin={consentPlugin}
        onDecision={decideConsent}
      />
      <PluginRemoveDialog
        plugin={removePlugin}
        busy={Boolean(removePlugin && busyPluginKeys.has(removePlugin.pluginKey))}
        onCancel={() => setRemovePluginId(null)}
        onConfirm={(pluginKey) => void remove(pluginKey)}
      />
      <PluginRollbackDialog
        plugin={marketplaceLifecycle.rollbackPlugin}
        busy={Boolean(
          marketplaceLifecycle.rollbackPlugin &&
          busyPluginKeys.has(marketplaceLifecycle.rollbackPlugin.pluginKey)
        )}
        error={marketplaceLifecycle.rollbackError}
        onCancel={marketplaceLifecycle.cancelRollback}
        onConfirm={(pluginKey) => void marketplaceLifecycle.confirmRollback(pluginKey)}
      />
    </SettingsSection>
  )
}
