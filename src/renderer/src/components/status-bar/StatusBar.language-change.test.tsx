// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'

vi.mock('./use-status-bar-controller', () => ({
  useStatusBarController: () => ({
    anyVisible: true,
    isEmptyUsageState: false,
    rosterProviders: [],
    collapsedUsageProviders: [],
    statusBarUsageMode: 'compact',
    usagePercentageDisplay: 'used',
    handleRefresh: vi.fn()
  })
}))
vi.mock('./CaffeinateStatusSegment', () => ({ CaffeinateStatusSegment: () => null }))
vi.mock('./RemoteServerUpdateStatusSegment', () => ({
  RemoteServerUpdateStatusSegment: () => null
}))
vi.mock('./SkillUpdateStatusSegment', () => ({ SkillUpdateStatusSegment: () => null }))
vi.mock('./NativeChatResumeStatusSegment', () => ({ NativeChatResumeStatusSegment: () => null }))
vi.mock('./UpdateStatusSegment', () => ({ UpdateStatusSegment: () => null }))
vi.mock('./StatusBarVisibilityMenu', () => ({ StatusBarVisibilityMenu: () => null }))

import { StatusBar } from './StatusBar'
import { TooltipProvider } from '@/components/ui/tooltip'

beforeEach(async () => {
  await i18n.changeLanguage('en')
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('refreshes mounted status bar labels after switching language without changing props', async () => {
  render(
    <TooltipProvider>
      <StatusBar floatingTerminalOpen={false} />
    </TooltipProvider>
  )
  const refreshButton = screen.getByRole('button', { name: 'Refresh rate limits' })

  await act(async () => {
    await i18n.changeLanguage('ja')
  })

  expect(screen.getByRole('button', { name: 'レート制限をリセット' })).toBe(refreshButton)

  await act(async () => {
    await i18n.changeLanguage('en')
  })
  expect(screen.getByRole('button', { name: 'Refresh rate limits' })).toBe(refreshButton)
})
