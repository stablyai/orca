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

// A web client unpaired from its host holds no value, so it shows no control.
it.each([undefined, 'ask', 'full-access'] as const)(
  'offers the new-chat default only for a host value %s',
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
