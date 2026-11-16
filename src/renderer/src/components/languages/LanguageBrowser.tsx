import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugins/localization/plugin-language-packs'
import { getRendererLanguageDetection, SUPPORTED_UI_LOCALES } from '../../../../shared/i18n/ui-locale'
import { isPluginUiLanguage, UI_LANGUAGE_SYSTEM } from '../../../../shared/i18n/ui-language'
import {
  isUsablePluginLanguagePack,
  PLUGIN_LANGUAGE_PACK_MIN_COVERAGE
} from '../../../../shared/plugins/languages/plugin-language-pack-coverage'
import { requestPluginBrowse } from '@/store/plugins/navigation/plugin-preview-request'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { LanguageRowModel } from './LanguagePackRow'
import { LanguagePickerView } from './LanguagePickerView'
import { previousUiLanguageName } from './previous-ui-language-name'
import {
  availableCatalogPacks,
  languageMatchesDevice,
  languageNames,
  packPublisher,
  sharedLanguageNames
} from './language-pack-options'
import { getUiLanguageNativeLabel } from '@/i18n/supported-languages'
import { deviceLanguageOffer } from './device-language-offer'
import { useUiLanguageSelection } from './use-ui-language-selection'
import { useLanguagePackCatalog } from './use-language-pack-catalog'
import { useLanguagePackSelection } from './use-language-pack-selection'

export function LanguageBrowser({
  onboarding = false,
  initialQuery = '',
  onClose
}: {
  onboarding?: boolean
  initialQuery?: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const entries = usePluginLanguagePackStore((state) => state.entries)
  const detection =
    useLanguageReadiness((state) => state.detection) ?? getRendererLanguageDetection()
  const catalogError = useLanguageReadiness((state) => state.error)
  // Why: plugins run only in the desktop app, so the web client can't browse or install packs.
  const catalogSupported = !isWebClientLocation()
  const catalog = useLanguagePackCatalog()
  // Why no toast: the picker stays open above the toast layer, and its check and footer confirm it.
  const selection = useLanguagePackSelection(onboarding, { announce: false })
  const [query, setQuery] = useState(initialQuery)
  // Why: hook errors aren't tied to a language, so remember which row asked to attach them there.
  const [lastAttempt, setLastAttempt] = useState<{
    id: string
    kind: 'choose' | 'install'
  } | null>(null)
  // Why a string: `null` is the list, a string (possibly empty) is the request form's prefill.
  const [requestDraft, setRequestDraft] = useState<string | null>(null)
  const { selecting, error, choose, restore } = useUiLanguageSelection({
    onboarding,
    // Why: outside onboarding a pick closes the picker, so the toast (with Switch back) is visible.
    announce: !onboarding,
    onClose,
    disabled: selection.busy !== null
  })
  const busy = selecting !== null || selection.busy !== null
  const current = catalogError ? null : settings?.uiLanguage
  const pluginsEnabled = settings?.pluginSystemEnabled === true
  const available = availableCatalogPacks(entries, catalog.packs)
  // Why the shared helper: settings, the toast and this pinned row must offer the same pack.
  const offer =
    detection.status === 'unsupported'
      ? deviceLanguageOffer(
          entries.filter(isUsablePluginLanguagePack),
          available,
          detection.detectedTag
        )
      : null
  const recommendation = offer?.installed ?? offer?.catalog ?? undefined
  // Why: a saved language whose catalog failed is not "current"; selecting it again retries the load.
  const failedId = catalogError ? (settings?.uiLanguage ?? null) : null
  const failedPack = entries.find((entry) => entry.id === failedId)
  const failedName = failedPack
    ? languageNames(failedPack.locale).native
    : failedId && !isPluginUiLanguage(failedId) && failedId !== UI_LANGUAGE_SYSTEM
      ? languageNames(failedId).native
      : t('languages.yourLanguage', 'Your language')
  const searching = query.trim() !== ''
  // Why per kind: each hook clears its own error only when it runs again.
  const rowError = (id: string): string | undefined =>
    lastAttempt?.id !== id
      ? undefined
      : ((lastAttempt.kind === 'install' ? selection.error : error) ?? undefined)
  const pick =
    (id: string, run: () => void, kind: 'choose' | 'install' = 'choose') =>
    () => {
      setLastAttempt({ id, kind })
      run()
    }
  const needle = query.trim().toLocaleLowerCase()
  const matches = (...terms: string[]): boolean =>
    terms.join(' ').toLocaleLowerCase().includes(needle)

  const systemName = t('settings.appearance.language.system', 'System')
  const systemNames = languageNames(detection.locale)
  const builtIns: LanguageRowModel[] = [
    ...(matches(systemName, 'system', systemNames.native, systemNames.english)
      ? [
          {
            id: UI_LANGUAGE_SYSTEM,
            name: systemName,
            hint: systemNames.native,
            hintLang: detection.locale,
            selected: current === UI_LANGUAGE_SYSTEM,
            failed: failedId === UI_LANGUAGE_SYSTEM,
            busy: selecting === UI_LANGUAGE_SYSTEM,
            disabled: busy,
            error: rowError(UI_LANGUAGE_SYSTEM),
            onSelect: pick(UI_LANGUAGE_SYSTEM, () => void choose(UI_LANGUAGE_SYSTEM, systemName))
          }
        ]
      : []),
    ...SUPPORTED_UI_LOCALES.flatMap((locale) => {
      // Why: built-ins keep Orca's curated names ("中文（简体）", "Português (Brasil)") so variants stay distinct.
      const names = { ...languageNames(locale), native: getUiLanguageNativeLabel(locale) }
      if (!matches(names.native, names.english, locale)) {
        return []
      }
      return [
        {
          id: locale,
          name: names.native,
          nameLang: locale,
          hint: names.english === names.native ? undefined : names.english,
          selected: current === locale,
          failed: failedId === locale,
          // Why: a failed load falls back to English, so that is what the user is looking at.
          effective: failedId !== null && failedId !== locale && locale === 'en',
          error: rowError(locale),
          device:
            detection.status === 'supported' &&
            languageMatchesDevice(locale, detection.detectedTag),
          busy: selecting === locale,
          disabled: busy,
          onSelect: pick(locale, () => void choose(locale, names.native))
        }
      ]
    })
  ]

  const packError = (
    id: string,
    phase: ReturnType<typeof selection.phaseOf> | null
  ): string | undefined => (phase?.kind === 'error' ? phase.message : undefined) ?? rowError(id)
  const installPhaseOf = (
    phase: ReturnType<typeof selection.phaseOf> | null
  ): 'preparing' | 'installing' | undefined =>
    phase?.kind === 'preparing' || phase?.kind === 'installing' ? phase.kind : undefined
  // Why settled: a pinned row that appears or vanishes as the catalog lands would shove the list.
  const catalogSettled = !catalogSupported || catalog.loaded
  const pinnedId =
    recommendation !== undefined && catalogSettled && pluginsEnabled && !searching
      ? recommendation.id
      : null
  const allPacks = [...entries, ...available]
  const sharedNames = sharedLanguageNames(allPacks)
  const packRows: LanguageRowModel[] = allPacks
    .filter((pack) => {
      const names = languageNames(pack.locale)
      return matches(names.native, names.english, pack.locale, packPublisher(pack))
    })
    .sort(
      (a, b) =>
        languageNames(a.locale).native.localeCompare(languageNames(b.locale).native) ||
        // Why: of two packs for one language, the installed one is the likelier pick.
        Number('listing' in a) - Number('listing' in b)
    )
    .map((pack) => {
      const names = languageNames(pack.locale)
      const availablePack = 'listing' in pack ? pack : null
      const coverage = 'coverage' in pack ? pack.coverage : undefined
      const phase = availablePack ? selection.phaseOf(availablePack.listing.pluginKey) : null
      const pinned = pack.id === pinnedId
      return {
        id: pack.id,
        name: names.native,
        nameLang: pack.locale,
        hint: names.english === names.native ? undefined : names.english,
        // Why: the publisher only earns space when it is what tells two packs apart.
        publisher: sharedNames.has(names.native) ? packPublisher(pack) : undefined,
        coverage:
          coverage !== undefined && coverage < PLUGIN_LANGUAGE_PACK_MIN_COVERAGE
            ? coverage
            : undefined,
        selected: current === pack.id,
        device: pinned,
        autoFocusTarget: pinned,
        needsInstall: availablePack !== null,
        failed: failedId === pack.id,
        // Why from the phase: `selection.busy` also spans the trust prompt, which isn't progress.
        busy: installPhaseOf(phase) !== undefined || selecting === pack.id,
        installPhase: installPhaseOf(phase),
        disabled: busy,
        unavailable: !pluginsEnabled,
        error: packError(pack.id, phase),
        onSelect: availablePack
          ? pick(pack.id, () => void selection.install(availablePack), 'install')
          : pick(pack.id, () => void choose(pack.id, names.native))
      }
    })
  const pinned = packRows.find((row) => row.id === pinnedId) ?? null
  const community = packRows.filter((row) => row.id !== pinnedId)
  const installing = available.some(
    (pack) => selection.phaseOf(pack.listing.pluginKey)?.kind === 'installing'
  )

  const previous = settings?.uiLanguageBeforePlugin
  const switchBackTo =
    settings && isPluginUiLanguage(settings.uiLanguage)
      ? {
          name: previousUiLanguageName(previous),
          lang:
            previous && previous !== UI_LANGUAGE_SYSTEM && !isPluginUiLanguage(previous)
              ? previous
              : 'en'
        }
      : null

  return (
    <LanguagePickerView
      onboarding={onboarding}
      query={query}
      onQueryChange={setQuery}
      pinned={pinned}
      builtIns={builtIns}
      community={community}
      catalogStatus={
        !catalogSupported
          ? 'ready'
          : !catalog.loaded
            ? 'loading'
            : catalog.error
              ? 'error'
              : 'ready'
      }
      catalogSupported={catalogSupported}
      refreshing={catalog.refreshing}
      busy={busy}
      footerBusy={selecting !== null || installing}
      onRefresh={() => void catalog.refresh()}
      pluginsDisabled={settings?.pluginSystemEnabled === false}
      failedLanguage={failedId ? { name: failedName } : null}
      onRetryLanguage={() => {
        if (failedId) {
          setLastAttempt({ id: failedId, kind: 'choose' })
          void choose(failedId, failedName)
        }
      }}
      // Why: an error from a row's own attempt shows under that row instead.
      error={lastAttempt === null ? error : null}
      switchBackTo={switchBackTo}
      onSwitchBack={() => {
        setLastAttempt(null)
        void restore()
      }}
      requesting={requestDraft !== null}
      requestDraft={requestDraft ?? undefined}
      onRequest={isWebClientLocation() ? undefined : (draft = '') => setRequestDraft(draft)}
      onRequestBack={() => setRequestDraft(null)}
      onManagePlugins={
        onboarding || !catalogSupported
          ? undefined
          : () => {
              onClose()
              requestPluginBrowse('translations')
            }
      }
      onDone={onClose}
    />
  )
}
