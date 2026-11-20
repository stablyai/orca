// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageLimitStopMark } from './BotUsageLimitMark'

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

it('shows the reset clock in the UI language, not the OS locale', async () => {
  const at = new Date()
  at.setHours(15, 0, 0, 0)
  await setRendererUiLanguage('ja')
  render(
    <TranslationScopeProvider>
      <TooltipProvider>
        <UsageLimitStopMark stop={{ at: at.getTime(), auto: true, agent: 'claude' }} />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
  const mark = screen.getByRole('img')
  expect(mark.getAttribute('aria-label')).toContain('15:00')

  await act(() => setRendererUiLanguage('en'))
  expect(mark.getAttribute('aria-label')).toMatch(/3:00\sPM/u)
})
