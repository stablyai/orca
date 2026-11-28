import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SpellcheckLanguagesSetting } from './SpellcheckLanguagesSetting'

const LANGUAGES = [
  'de',
  'en-GB',
  'en-US',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt-BR',
  'ru',
  'sv',
  'tr',
  'uk',
  'zh-CN',
  'zh-TW'
]

function installFixtureApi(): void {
  Reflect.set(window.api.settings, 'listSpellcheckLanguages', async () => LANGUAGES)
  const platform = window.api.platform.get()
  Reflect.set(window.api.platform, 'get', () => ({ ...platform, platform: 'linux' }))
}

const WIDTH = 720

export const systemDefault = defineFixture({
  width: WIDTH,
  setup: installFixtureApi,
  render: () => (
    <SpellcheckLanguagesSetting settings={{ spellcheckLanguages: [] }} updateSettings={() => {}} />
  )
})

export const twoLanguages = defineFixture({
  width: WIDTH,
  setup: installFixtureApi,
  render: () => (
    <SpellcheckLanguagesSetting
      settings={{ spellcheckLanguages: ['en-US', 'ja'] }}
      updateSettings={() => {}}
    />
  )
})

export const pickerOpen = defineFixture({
  width: WIDTH,
  setup: installFixtureApi,
  render: () => (
    <SpellcheckLanguagesSetting
      settings={{ spellcheckLanguages: ['en-US'] }}
      updateSettings={() => {}}
    />
  ),
  interact: (frame) => {
    frame.querySelector('button')?.click()
  }
})
