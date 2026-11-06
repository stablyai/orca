// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { AppearanceChatSection } from './AppearanceChatSection'

afterEach(cleanup)

it('Reset turns both hidden chat cards back on', () => {
  const settings = {
    ...getDefaultSettings('/tmp'),
    nativeChatTurnDiffSummary: false,
    nativeChatOpenedPullRequests: false
  }
  useAppStore.setState({ settings })
  const updateSettings = vi.fn()
  render(<AppearanceChatSection settings={settings} updateSettings={updateSettings} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(updateSettings).toHaveBeenCalledWith({
    nativeChatTurnDiffSummary: true,
    nativeChatOpenedPullRequests: true
  })
})
