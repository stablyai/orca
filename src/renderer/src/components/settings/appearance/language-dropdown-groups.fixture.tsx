import { Languages } from 'lucide-react'
import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type { CatalogLanguagePack } from '@/components/languages/language-pack-options'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsSearchableSelect } from '../form-controls/SettingsSearchableSelect'
import { languageDropdownGroups } from './language-dropdown-groups'
import { UI_LANGUAGE_CHOICES, getUiLanguageChoiceLabel } from '@/i18n/supported-languages'

const noop = (): void => {}
const noInstalledPacks: PluginLanguagePackRegistration[] = []

// Why the real choices: the community group's position depends on the full built-in list.
const builtIns = UI_LANGUAGE_CHOICES.map((choice) => ({
  value: choice.value,
  label:
    choice.value === 'system' ? 'System (English)' : getUiLanguageChoiceLabel(choice, translate),
  lang: choice.value === 'system' ? undefined : choice.value
}))
function catalogPack(publisher: string, locale: string): CatalogLanguagePack {
  const pluginKey = `${publisher}.orca-${locale}`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dropdown reads only listing.pluginKey.
  const listing = { pluginKey } as CatalogLanguagePack['listing']
  return { id: `plugin:${pluginKey}/${locale}`, locale, listing }
}

function installedPack(publisher: string, locale: string): PluginLanguagePackRegistration {
  const pluginKey = `${publisher}.orca-${locale}`
  return {
    id: `plugin:${pluginKey}/${locale}`,
    resourceLanguage: locale,
    pluginKey,
    locale,
    catalog: {},
    coverage: 94
  }
}

const catalogPacks = [
  catalogPack('ebbop', 'it'),
  catalogPack('matteoeusebi', 'it'),
  catalogPack('dohaidang', 'vi'),
  catalogPack('mancunianez', 'uk')
]

function LanguageDropdown({
  installed = noInstalledPacks,
  catalog,
  query
}: {
  installed?: PluginLanguagePackRegistration[]
  catalog: readonly CatalogLanguagePack[]
  query?: string
}) {
  const groups = languageDropdownGroups({ builtIns, installed, catalog, t: translate })
  return (
    <div className="pb-[420px]">
      <SettingsGroup>
        <SettingsRow
          label="Language"
          control={
            <SettingsSearchableSelect
              ariaLabel="Language"
              value="system"
              groups={groups}
              query={query}
              onValueChange={noop}
              searchPlaceholder="Search languages…"
              navigableActions
              actions={[
                {
                  key: 'more-languages',
                  label: 'More languages…',
                  icon: <Languages className="size-3.5" />,
                  onSelect: noop
                }
              ]}
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}

const openDropdown = (frame: HTMLElement): void => {
  frame.querySelector<HTMLButtonElement>('button[aria-label="Language"]')?.click()
}

export const catalogLoaded = defineFixture({
  width: 720,
  render: () => <LanguageDropdown catalog={catalogPacks} />,
  interact: openDropdown
})

export const catalogNotReady = defineFixture({
  width: 720,
  render: () => <LanguageDropdown installed={[installedPack('ebbop', 'it')]} catalog={[]} />,
  interact: openDropdown
})

export const installedAndAvailableDuplicate = defineFixture({
  width: 720,
  render: () => (
    <LanguageDropdown installed={[installedPack('ebbop', 'it')]} catalog={catalogPacks} />
  ),
  interact: openDropdown
})

export const searchingItal = defineFixture({
  width: 720,
  render: () => (
    <LanguageDropdown
      installed={[installedPack('ebbop', 'it')]}
      catalog={catalogPacks}
      query="ital"
    />
  ),
  interact: openDropdown
})

export const catalogLoadedScrolled = defineFixture({
  width: 720,
  render: () => (
    <LanguageDropdown installed={[installedPack('ebbop', 'it')]} catalog={catalogPacks} />
  ),
  interact: async (frame) => {
    openDropdown(frame)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const list = document.querySelector<HTMLElement>('[cmdk-list]')
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }
})
