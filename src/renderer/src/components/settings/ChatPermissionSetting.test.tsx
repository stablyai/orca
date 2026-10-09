// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ChatPermissionSetting } from './ChatPermissionSetting'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
afterEach(cleanup)

it.each([undefined, 'ask', 'bypass'] as const)(
  'offers the default control only for projected host mode %s',
  (mode) => {
    const { container } = render(
      <TooltipProvider>
        <ChatPermissionSetting
          settings={{ ...getDefaultSettings('/tmp'), nativeChatPermissionMode: mode }}
          updateSettings={vi.fn()}
          forceVisible
        />
      </TooltipProvider>
    )
    if (mode === undefined) {
      expect(container.querySelector('#chat-permissions')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    } else {
      expect(
        screen.getByRole('button', {
          name: `Permissions ${mode === 'ask' ? 'Ask for approval' : 'Full access'}`
        })
      ).toBeTruthy()
    }
  }
)
