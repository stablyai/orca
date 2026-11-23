import { useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import {
  LanguagePackDiscoverySummary,
  type LanguageSettingHint
} from '@/components/languages/LanguagePackDiscoverySummary'
import {
  normalizeUiLanguage,
  isPluginUiLanguage,
  type UiLanguage
} from '../../../../../shared/i18n/ui-language'
import { LanguagePickerDialog } from '@/components/languages/LanguagePickerDialog'
import { useLanguageOfferAction } from '@/components/languages/use-language-offer-action'
import {
  catalogPackOffer,
  deviceLanguageOffer,
  offerSummary,
  type DeviceLanguageOffer
} from '@/components/languages/device-language-offer'
import { useLanguagePackCatalog } from '@/components/languages/use-language-pack-catalog'
import { packPublisher } from '@/components/languages/language-pack-options'
import { currentFocusTarget, firstConnected } from '@/components/languages/focus-return'
import { previousUiLanguageName } from '@/components/languages/previous-ui-language-name'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { UI_LANGUAGE_CHOICES, getUiLanguageNativeLabel } from '@/i18n/supported-languages'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectOption
} from '../form-controls/SettingsSearchableSelect'
import { getLanguageEntries } from './appearance-search'
import { useUiLanguagePickerLabels } from './use-appearance-picker-labels'
import { INSTALL_LANGUAGE_VALUE_PREFIX, languageDropdownGroups } from './language-dropdown-groups'

const LANGUAGE_ROW_ID = 'appearance-language-row'

type AppearanceLanguageSettingProps = {
  uiLanguage: UiLanguage
  forceVisible: boolean
}

function useLanguageSettingOffer(
  uiLanguage: UiLanguage,
  installed: ReturnType<typeof useUiLanguagePickerLabels>['packs'],
  /** This client can install packs, so the dropdown lists the catalog too. */
  catalogSupported: boolean
): {
  hint: LanguageSettingHint
  offer: DeviceLanguageOffer | null
  catalog: ReturnType<typeof useLanguagePackCatalog>
} {
  const previous = useAppStore((state) => state.settings?.uiLanguageBeforePlugin)
  const detection = useLanguageReadiness((state) => state.detection)
  const unsupported = detection?.status === 'unsupported'
  // Why on mount: a catalog read before the dropdown opens keeps the menu from growing under the pointer.
  const catalog = useLanguagePackCatalog(catalogSupported)
  if (isPluginUiLanguage(uiLanguage)) {
    const active = installed.find((pack) => pack.id === uiLanguage)
    return {
      hint: {
        kind: 'community',
        publisher: active ? packPublisher(active) : null,
        previousName: previousUiLanguageName(previous)
      },
      offer: null,
      catalog
    }
  }
  const offer = unsupported
    ? deviceLanguageOffer(installed, catalog.packs, detection.detectedTag)
    : null
  return {
    hint: offer ? { kind: 'offer', offer: offerSummary(offer) } : { kind: 'browse' },
    offer,
    catalog
  }
}

export function AppearanceLanguageSetting({
  uiLanguage,
  forceVisible
}: AppearanceLanguageSettingProps): React.JSX.Element {
  const t = useTranslate()
  const selection = useLanguageOfferAction()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserQuery, setBrowserQuery] = useState('')
  const [selectQuery, setSelectQuery] = useState('')
  const detectionStatus = useLanguageReadiness((state) => state.detection?.status)
  const languages = useUiLanguagePickerLabels()
  const pluginsEnabled = useAppStore((state) => state.settings?.pluginSystemEnabled === true)
  // Why only plugins: the catalog hook itself returns nothing on the web client.
  const catalogSupported = pluginsEnabled
  const { hint, offer, catalog } = useLanguageSettingOffer(
    uiLanguage,
    languages.packs,
    catalogSupported
  )
  const error = selection.errorFor(selection.lastAttempt ?? offer)
  const accepting = selection.accepting
  const pending =
    accepting && selection.progress
      ? { offer: offerSummary(accepting), progress: selection.progress }
      : null
  // Why the trigger fallback: a footer action's search field is gone when the picker closes.
  const browserOpener = useRef<HTMLElement | null>(null)
  const openBrowser = (query: string): void => {
    browserOpener.current = currentFocusTarget()
    setBrowserQuery(query)
    setBrowserOpen(true)
  }
  const browserReturnFocus = (): HTMLElement | null =>
    firstConnected(
      browserOpener.current,
      document.querySelector<HTMLElement>(`#${LANGUAGE_ROW_ID} button[role="combobox"]`)
    )
  const languageEntry = getLanguageEntries()[0]
  const languageTitle = t('settings.appearance.language.title', 'Language')
  const builtInOptions: SettingsSearchableSelectOption[] = UI_LANGUAGE_CHOICES.map(
    (choice, index) => ({
      value: choice.value,
      // Why: an unsupported device language falls back to English; say so where System is picked.
      label:
        choice.value === 'system' && detectionStatus === 'unsupported'
          ? t('languages.systemResolved', '{{system}} ({{language}})', {
              system: languages.choices[index],
              language: getUiLanguageNativeLabel('en')
            })
          : languages.choices[index],
      keywords: [choice.value],
      lang: choice.value === 'system' ? undefined : choice.value
    })
  )
  if (
    !builtInOptions.some((option) => option.value === uiLanguage) &&
    !languages.packs.some((pack) => pack.id === uiLanguage)
  ) {
    builtInOptions.push({
      value: uiLanguage,
      label: t(
        'auto.components.settings.AppearanceInterfaceSection.languageUnavailable',
        '{{value0}} (unavailable)',
        { value0: uiLanguage }
      ),
      disabled: true
    })
  }
  const dropdownGroups = languageDropdownGroups({
    builtIns: builtInOptions,
    installed: languages.packs,
    catalog: catalogSupported && catalog.loaded && !catalog.error ? catalog.packs : [],
    t
  })
  const allOptions = dropdownGroups.flatMap((group) => group.options)
  // Why: main shows no description; text appears only when there is something to act on.
  const showDescription = hint.kind !== 'browse' || pending !== null || error !== null

  return (
    <SearchableSetting
      title={languageTitle}
      description={languageEntry?.description}
      keywords={languageEntry?.keywords ?? []}
      forceVisible={forceVisible}
      id="appearance-language"
    >
      <SettingsRow
        id={LANGUAGE_ROW_ID}
        label={languageTitle}
        description={
          showDescription ? (
            <LanguagePackDiscoverySummary
              hint={hint}
              busy={selection.busy}
              pending={pending}
              error={error}
              onAccept={() => {
                // Why: "Try again" retries the failed pack; otherwise the link accepts this row's offer.
                const target = error ? (selection.lastAttempt ?? offer) : offer
                if (target) {
                  void selection.accept(target)
                }
              }}
              onRestore={() => void selection.restore()}
            />
          ) : undefined
        }
        control={
          <SettingsSearchableSelect
            ariaLabel={languageTitle}
            value={uiLanguage}
            groups={dropdownGroups}
            // Why: re-picking the saved language is the visible way to retry a catalog that failed to load.
            allowReselect
            disabled={selection.busy}
            onValueChange={(value) => {
              if (value.startsWith(INSTALL_LANGUAGE_VALUE_PREFIX)) {
                const id = value.slice(INSTALL_LANGUAGE_VALUE_PREFIX.length)
                const pack = catalog.packs.find((candidate) => candidate.id === id)
                if (pack) {
                  void selection.accept(catalogPackOffer(pack))
                }
                return
              }
              void selection.choose(
                normalizeUiLanguage(value),
                allOptions.find((option) => option.value === value)?.label ?? value
              )
            }}
            searchPlaceholder={t(
              'auto.components.settings.SettingsSearchableSelect.searchLanguages',
              'Search languages…'
            )}
            onQueryChange={setSelectQuery}
            navigableActions
            actions={[
              {
                key: 'more-languages',
                label: t('languages.moreLanguages', 'More languages…'),
                icon: <Languages className="size-3.5" />,
                // Why carry the query: typing a missing language is the likeliest way to look for one.
                onSelect: () => openBrowser(selectQuery.trim())
              }
            ]}
          />
        }
      />
      <LanguagePickerDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        initialQuery={browserQuery}
        returnFocus={browserReturnFocus}
      />
    </SearchableSetting>
  )
}
