import { Languages } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SettingsGroup } from '../settings/section-layout/SettingsGroup'
import { SettingsRow } from '../settings/form-controls/SettingsFormControls'
import { SettingsSearchableSelect } from '../settings/form-controls/SettingsSearchableSelect'
import {
  LanguagePackDiscoverySummary,
  type LanguageSettingHint
} from './LanguagePackDiscoverySummary'
import type { LanguageOfferSummary } from './device-language-offer'
import type { LanguageOfferProgress } from './use-language-offer-action'

const noop = (): void => {}

const italian: LanguageOfferSummary = {
  locale: 'it',
  name: 'italiano',
  englishName: 'Italian',
  installed: false
}

// Mirrors AppearanceLanguageSetting's row so the description is judged in the settings rhythm.
function LanguageRow({
  hint,
  value = 'system',
  progress = null,
  error = null,
  query
}: {
  query?: string
  hint: LanguageSettingHint
  value?: string
  progress?: LanguageOfferProgress
  error?: string | null
}) {
  return (
    <SettingsGroup title="Interface">
      <SettingsRow label="UI zoom" control={<span className="text-sm">100%</span>} />
      <SettingsRow
        label="Language"
        description={
          hint.kind === 'browse' && !progress && !error ? undefined : (
            <LanguagePackDiscoverySummary
              hint={hint}
              busy={progress !== null}
              pending={progress ? { offer: italian, progress } : null}
              error={error}
              onAccept={noop}
              onRestore={noop}
            />
          )
        }
        control={
          <SettingsSearchableSelect
            ariaLabel="Language"
            value={value}
            groups={[
              {
                key: 'ui-languages',
                options: [
                  {
                    value: 'system',
                    label: hint.kind === 'browse' ? 'System' : 'System (English)'
                  },
                  { value: 'en', label: 'English' },
                  { value: 'plugin:ebbop.orca-italian/it', label: 'italiano' }
                ]
              }
            ]}
            onValueChange={noop}
            searchPlaceholder="Search languages…"
            query={query}
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
      <SettingsRow label="IDE font" control={<span className="text-sm">Geist</span>} />
    </SettingsGroup>
  )
}

export const settingsRowDefault = defineFixture({
  width: 720,
  render: () => <LanguageRow hint={{ kind: 'browse' }} />
})

export const settingsRowOfferInstall = defineFixture({
  width: 720,
  render: () => <LanguageRow hint={{ kind: 'offer', offer: italian }} />
})

export const settingsRowOfferInstalled = defineFixture({
  width: 720,
  render: () => <LanguageRow hint={{ kind: 'offer', offer: { ...italian, installed: true } }} />
})

export const settingsRowOfferConfirming = defineFixture({
  width: 720,
  render: () => <LanguageRow progress="confirming" hint={{ kind: 'offer', offer: italian }} />
})

export const settingsRowOfferInstalling = defineFixture({
  width: 720,
  render: () => <LanguageRow progress="installing" hint={{ kind: 'offer', offer: italian }} />
})

export const settingsRowOfferError = defineFixture({
  width: 720,
  render: () => (
    <LanguageRow
      error="Couldn’t download. Check your connection."
      hint={{ kind: 'offer', offer: italian }}
    />
  )
})

export const settingsRowOfferNarrowLongName = defineFixture({
  width: 420,
  render: () => (
    <LanguageRow
      hint={{
        kind: 'offer',
        offer: {
          locale: 'id',
          name: 'Bahasa Indonesia',
          englishName: 'Indonesian',
          installed: false
        }
      }}
    />
  )
})

export const settingsRowOfferCjk = defineFixture({
  width: 720,
  render: () => (
    <LanguageRow
      hint={{
        kind: 'offer',
        offer: { locale: 'yue', name: '粵語', englishName: 'Cantonese', installed: false }
      }}
    />
  )
})

export const settingsRowOfferRtl = defineFixture({
  width: 720,
  render: () => (
    <LanguageRow
      hint={{
        kind: 'offer',
        offer: { locale: 'ar', name: 'العربية', englishName: 'Arabic', installed: false }
      }}
    />
  )
})

export const settingsRowCommunityActive = defineFixture({
  width: 720,
  render: () => (
    <LanguageRow
      hint={{ kind: 'community', publisher: 'ebbop', previousName: 'English (System)' }}
      value="plugin:ebbop.orca-italian/it"
    />
  )
})

export const settingsRowMoreLanguagesMenu = defineFixture({
  width: 720,
  render: () => <LanguageRow hint={{ kind: 'browse' }} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Language"]')?.click()
  }
})

export const settingsRowMenuNoMatch = defineFixture({
  width: 720,
  render: () => <LanguageRow hint={{ kind: 'browse' }} query="Svenska" />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Language"]')?.click()
  }
})
