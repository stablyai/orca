import { isPluginAutoUpdateOn } from '../../../../shared/plugins/catalog/plugin-update-policy'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PluginHostInstallSource, PluginHostListEntry } from '../../../../preload/api-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { PluginDevelopmentDialog } from '../plugins/dialogs/PluginDevelopmentDialog'
import { PluginInstallDialog } from '../plugins/dialogs/PluginInstallDialog'
import { PluginInstallTrustDialogHost } from '../plugins/dialogs/PluginInstallTrustDialog'
import { sourceInstallTrustPrompt } from '../plugins/presentation/plugin-install-trust'
import { confirmPluginInstallTrust } from '@/store/plugin-install-trust-request'
import { PluginRemoveDialog } from '../plugins/dialogs/PluginRemoveDialog'
import { PluginRollbackDialog } from '../plugins/dialogs/PluginRollbackDialog'
import { PluginsHeaderActions } from '../plugins/list/PluginSettingsMenu'
import { PluginSettingsOverview } from '../plugins/list/PluginSettingsOverview'
import { PluginsAlphaNotice } from '../plugins/list/PluginsAlphaNotice'
import { PluginsSectionDescription } from '../plugins/list/PluginsSectionDescription'
import { getPluginsSectionPresentation } from './plugins-search'
import { SettingsSection } from './SettingsSection'
import { usePluginLogs } from '../plugins/state/use-plugin-logs'
import { usePluginMarketplaceLifecycle } from '../plugins/state/use-plugin-marketplace-lifecycle'
import { usePluginPageNavigation } from '../plugins/state/use-plugin-page-navigation'
import { usePluginReviewQueue } from '../plugins/state/use-plugin-review-queue'
import { usePluginSettingsWrites } from '../plugins/state/use-plugin-settings-writes'
import { isPluginEnabled } from '../plugins/presentation/plugin-status-presentation'
import { applyPluginThemesNow } from '../plugins/state/plugin-theme-apply'

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
  const [installKind, setInstallKind] = useState<'local-path' | 'git' | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [developmentOpen, setDevelopmentOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [removePluginId, setRemovePluginId] = useState<string | null>(null)
  const [busyPluginKeys, setBusyPluginKeys] = useState<Set<string>>(() => new Set())
  const mountedRef = useRef(false)
  const listRequestRef = useRef(0)
  const review = usePluginReviewQueue()
  const page = usePluginPageNavigation(review.pause)
  const clearReviews = review.clear
  const installedKeysRef = useRef<ReadonlySet<string>>(new Set())
  const openPage = page.open
  // Why: review happens on the plugin's own page, where the consent sits above its one button.
  useEffect(() => {
    if (review.reviewKey) {
      openPage(review.reviewKey)
    }
  }, [review.reviewKey, openPage])

  const applyPluginList = (nextPlugins: PluginHostListEntry[]): void => {
    const installedPluginKeys = new Set(nextPlugins.map((plugin) => plugin.pluginKey))
    // Why: a plugin removed while its page is open closes the page, so a reinstall starts fresh.
    for (const pluginKey of installedKeysRef.current) {
      if (!installedPluginKeys.has(pluginKey)) {
        page.leave(pluginKey)
      }
    }
    installedKeysRef.current = installedPluginKeys
    setPlugins(nextPlugins)
    setError(null)
    // Why: accepted discovery results own installed-plugin identity and invalidate stale UI state.
    review.prune(installedPluginKeys)
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

  const loadPluginListForSubscription = useEffectEvent(async (): Promise<void> => {
    await loadPluginList(window.api.plugins.list())
    if (mountedRef.current) {
      setLoading(false)
    }
  })

  const clearBusy = (pluginKey: string): void => {
    if (mountedRef.current) {
      setBusyPluginKeys((current) => new Set([...current].filter((key) => key !== pluginKey)))
    }
  }

  const applyCompletedMutation = (nextPlugins: PluginHostListEntry[]): void => {
    if (!mountedRef.current) {
      return
    }
    // Completed mutations supersede older action starts and in-flight passive refreshes.
    listRequestRef.current += 1
    applyPluginList(nextPlugins)
  }

  const {
    devPathsBusy,
    settingsError,
    reset: resetSettingsWrites,
    toggleSuggestions,
    toggleAutoUpdate,
    updateDevPaths
  } = usePluginSettingsWrites({
    settings,
    updateSettings,
    mountedRef,
    rediscover: () => loadPluginList(window.api.plugins.refresh())
  })

  useEffect(() => {
    mountedRef.current = mounted
    if (!mounted) {
      // Reset hidden lazy panes so reopening cannot revive dialogs or unresolved async state.
      setPlugins([])
      setLoading(true)
      setError(null)
      setInstallKind(null)
      clearReviews()
      setRemovePluginId(null)
      setBusyPluginKeys(new Set())
      resetSettingsWrites()
    }
    return () => {
      mountedRef.current = false
      listRequestRef.current += 1
    }
  }, [mounted, clearReviews, resetSettingsWrites])

  useEffect(() => {
    if (!mounted) {
      return
    }
    setLoading(true)
    void loadPluginListForSubscription()
    const unsubscribe = window.api.plugins.onChanged(() => {
      void loadPluginListForSubscription()
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
    openReviews: review.enqueue,
    setBusyPluginKeys
  })
  const pluginLogs = usePluginLogs(mounted, mountedRef, plugins)

  const sectionPresentation = getPluginsSectionPresentation()

  if (!mounted) {
    return <SettingsSection id="plugins" {...sectionPresentation} />
  }

  const removePlugin = plugins.find((plugin) => plugin.pluginKey === removePluginId) ?? null

  const install = async (source: PluginHostInstallSource): Promise<void> => {
    if (!(await confirmPluginInstallTrust(sourceInstallTrustPrompt(source)))) {
      return
    }
    const result = await window.api.plugins.install(source)
    if (!result.ok) {
      throw new Error(result.error)
    }
    // Why: installation is not consent; select by id and wait for the authoritative list.
    setInstallKind(null)
    review.show(result.pluginKey)
    await loadPluginList(window.api.plugins.refresh())
  }

  const decideConsent = async (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ): Promise<void> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    // Why: re-approving an update keeps the user's current choice; a first Enable shows the theme.
    const firstEnable = !plugins.find((plugin) => plugin.pluginKey === pluginKey)?.needsReconsent
    try {
      const nextPlugins = await window.api.plugins.consent({
        pluginKey,
        reviewedFingerprint,
        decision
      })
      applyCompletedMutation(nextPlugins)
      if (decision === 'approve' && firstEnable) {
        void applyPluginThemesNow(pluginKey).catch(() => false)
      }
      if (mountedRef.current) {
        review.advance(nextPlugins)
      }
    } finally {
      clearBusy(pluginKey)
    }
  }

  const toggleEnabled = async (plugin: PluginHostListEntry): Promise<void> => {
    const enabled = isPluginEnabled(plugin)
    setBusyPluginKeys((current) => new Set(current).add(plugin.pluginKey))
    try {
      const nextEnabled = !enabled
      const nextPlugins = await window.api.plugins.setEnabled({
        pluginKey: plugin.pluginKey,
        enabled: nextEnabled
      })
      applyCompletedMutation(nextPlugins)
      // Why: enabling never grants consent, so a plugin that was never approved comes back
      // pending; open its review instead of silently flipping the row back to "Needs review".
      const next = nextPlugins.find((entry) => entry.pluginKey === plugin.pluginKey)
      if (nextEnabled && next?.status === 'pending' && mountedRef.current) {
        review.show(plugin.pluginKey)
      } else if (nextEnabled) {
        void applyPluginThemesNow(plugin.pluginKey).catch(() => false)
      }
    } catch (cause) {
      if (mountedRef.current) {
        setPluginListError(cause)
      }
    } finally {
      clearBusy(plugin.pluginKey)
    }
  }

  // Why: re-enabling resets the supervisor's restart budget, which is what "Restart" means here.
  const restart = async (pluginKey: string): Promise<void> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    try {
      applyCompletedMutation(await window.api.plugins.setEnabled({ pluginKey, enabled: false }))
      applyCompletedMutation(await window.api.plugins.setEnabled({ pluginKey, enabled: true }))
    } catch (cause) {
      if (mountedRef.current) {
        // Why: the stop may have landed before the start failed; show what is true now.
        void loadPluginList(window.api.plugins.list())
        toast.error(
          translate(
            'auto.components.settings.PluginsSettingsSection.restartFailed',
            "Couldn't restart {{value0}}.",
            {
              value0: plugins.find((plugin) => plugin.pluginKey === pluginKey)?.name ?? pluginKey
            }
          )
        )
        console.warn('[plugins] restart failed:', cause)
      }
    } finally {
      clearBusy(pluginKey)
    }
  }

  // Why one wrapper: a list mutation marks its plugin busy and shows a failure on the list.
  const mutateList = async (
    pluginKey: string,
    request: () => Promise<PluginHostListEntry[]>
  ): Promise<boolean> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    try {
      applyCompletedMutation(await request())
      return true
    } catch (cause) {
      if (mountedRef.current) {
        setPluginListError(cause)
      }
      return false
    } finally {
      clearBusy(pluginKey)
    }
  }

  const remove = async (pluginKey: string): Promise<void> => {
    if (
      (await mutateList(pluginKey, () => window.api.plugins.remove({ pluginKey }))) &&
      mountedRef.current
    ) {
      setRemovePluginId(null)
    }
  }

  const refresh = async (): Promise<void> => {
    await loadPluginList(window.api.plugins.refresh())
  }

  const featureEnabled = settings.pluginSystemEnabled
  return (
    <SettingsSection
      id="plugins"
      {...sectionPresentation}
      description={<PluginsSectionDescription text={sectionPresentation.description} />}
      hideHeader={featureEnabled && page.openKey !== null}
      bodyClassName="space-y-6 rounded-none border-0 bg-transparent p-0 shadow-none"
      headerAction={
        <PluginsHeaderActions
          featureEnabled={featureEnabled}
          suggestionsEnabled={settings.pluginFileTypeSuggestions !== false}
          onToggleSuggestions={() => void toggleSuggestions()}
          autoUpdateEnabled={isPluginAutoUpdateOn(settings)}
          onToggleAutoUpdate={() => void toggleAutoUpdate()}
          open={settingsMenuOpen}
          onOpenChange={setSettingsMenuOpen}
          onAdd={setInstallKind}
          onSources={() => setSourcesOpen(true)}
          onDevelopment={() => setDevelopmentOpen(true)}
        />
      }
    >
      {featureEnabled && page.openKey !== null ? null : <PluginsAlphaNotice />}
      <PluginSettingsOverview
        featureEnabled={featureEnabled}
        settingsError={settingsError}
        loading={loading}
        error={error}
        plugins={plugins}
        busyPluginKeys={busyPluginKeys}
        onConsent={decideConsent}
        handlers={{
          onReview: review.show,
          onToggleEnabled: (pluginKey) => {
            const plugin = plugins.find((entry) => entry.pluginKey === pluginKey)
            if (plugin) {
              void toggleEnabled(plugin)
            }
          },
          onRestart: (pluginKey) => void restart(pluginKey),
          onRollbackRequest: marketplaceLifecycle.requestRollback,
          onRemoveRequest: setRemovePluginId
        }}
        onRefresh={refresh}
        onMarketplaceInstalled={marketplaceLifecycle.reloadAfterMutation}
        logsByPlugin={pluginLogs.logsByPlugin}
        onShowLogs={pluginLogs.showLogs}
        sourcesOpen={sourcesOpen}
        setSourcesOpen={setSourcesOpen}
        page={page}
        onOpenShortcuts={() =>
          useAppStore.getState().openSettingsTarget({ pane: 'shortcuts', repoId: null })
        }
      />
      <PluginInstallDialog
        key={installKind ?? 'closed'}
        open={installKind !== null}
        initialKind={installKind ?? 'local-path'}
        onOpenChange={(open) => {
          if (!open) {
            setInstallKind(null)
          }
        }}
        onInstall={install}
      />
      <PluginDevelopmentDialog
        open={developmentOpen}
        onOpenChange={setDevelopmentOpen}
        paths={settings.devPluginPaths}
        busy={devPathsBusy}
        onChange={updateDevPaths}
      />
      <PluginInstallTrustDialogHost />
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
