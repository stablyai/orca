// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { memo } from 'react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from './i18n'
import { TranslationScopeProvider } from './translation-scope-provider'
import { useTranslate, type Translate } from './use-translate'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('gives memoized components a new translate function when the language switches', async () => {
  i18n.addResourceBundle('de', 'translation', { 'test.useTranslate.greeting': 'Hallo' }, true, true)
  const seen: Translate[] = []
  const Greeting = memo(function Greeting() {
    const t = useTranslate()
    seen.push(t)
    return <span>{t('test.useTranslate.greeting', 'Hello')}</span>
  })
  const view = render(
    <TranslationScopeProvider>
      <Greeting />
    </TranslationScopeProvider>
  )
  view.rerender(
    <TranslationScopeProvider>
      <Greeting />
    </TranslationScopeProvider>
  )
  expect(screen.getByText('Hello')).toBeTruthy()
  const english = seen.at(-1)

  await act(() => i18n.changeLanguage('de'))

  expect(screen.getByText('Hallo')).toBeTruthy()
  expect(seen.at(-1)).not.toBe(english)
})
