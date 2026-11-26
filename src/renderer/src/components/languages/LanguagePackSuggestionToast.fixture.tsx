import { defineFixture } from '../../component-fixtures/component-fixture'
import type { LanguageOfferSummary } from './device-language-offer'
import { LanguagePackSuggestionToast } from './LanguagePackSuggestionToast'

const noop = (): void => {}
const actions = { onAccept: noop, onClose: noop }
const italian: LanguageOfferSummary = {
  locale: 'it',
  name: 'italiano',
  englishName: 'Italian',
  installed: false
}

export const suggestionToast = defineFixture({
  width: 448,
  render: () => <LanguagePackSuggestionToast offer={italian} {...actions} />
})

export const suggestionToastInstalled = defineFixture({
  width: 448,
  render: () => <LanguagePackSuggestionToast offer={{ ...italian, installed: true }} {...actions} />
})

export const suggestionToastInstalling = defineFixture({
  width: 448,
  render: () => <LanguagePackSuggestionToast offer={italian} progress="installing" {...actions} />
})

export const suggestionToastError = defineFixture({
  width: 448,
  render: () => (
    <LanguagePackSuggestionToast
      offer={italian}
      error="Couldn’t download. Check your connection."
      {...actions}
    />
  )
})

export const suggestionToastCjk = defineFixture({
  width: 448,
  render: () => (
    <LanguagePackSuggestionToast
      offer={{ locale: 'yue', name: '粵語', englishName: 'Cantonese', installed: false }}
      {...actions}
    />
  )
})

export const suggestionToastRtl = defineFixture({
  width: 448,
  render: () => (
    <LanguagePackSuggestionToast
      offer={{ locale: 'ar', name: 'العربية', englishName: 'Arabic', installed: false }}
      {...actions}
    />
  )
})

export const suggestionToastNarrow = defineFixture({
  width: 300,
  render: () => (
    <LanguagePackSuggestionToast
      offer={{
        locale: 'id',
        name: 'Bahasa Indonesia',
        englishName: 'Indonesian',
        installed: false
      }}
      {...actions}
    />
  )
})
