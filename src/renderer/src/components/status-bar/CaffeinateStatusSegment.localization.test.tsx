// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getAgentAwakeLidNote } from '../settings/agent-awake-copy'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'

const storeMocks = vi.hoisted(() => ({
  settings: {
    computerAwakeMode: 'off',
    keepComputerAwakeWhileAgentsRun: false
  },
  updateSettings: vi.fn()
}))

const awakeMocks = vi.hoisted(() => ({
  status: { mode: 'off', active: false },
  unsubscribe: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: storeMocks.settings, updateSettings: storeMocks.updateSettings })
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => false
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => (
    <div role="menuitemradio" aria-checked="false">
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />
}))

let previousLanguage: string

beforeAll(() => {
  previousLanguage = i18n.language
})

beforeEach(() => {
  storeMocks.settings = {
    computerAwakeMode: 'off',
    keepComputerAwakeWhileAgentsRun: false
  }
  awakeMocks.status = { mode: 'off', active: false }
  storeMocks.updateSettings.mockClear()
  awakeMocks.unsubscribe.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentAwake: {
        getStatus: vi.fn().mockImplementation(() => Promise.resolve(awakeMocks.status)),
        onChanged: vi.fn().mockReturnValue(awakeMocks.unsubscribe)
      }
    }
  })
})

afterEach(cleanup)

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage)
})

describe('keep-awake copy under non-English UI languages', () => {
  it('renders the localized Chinese trigger and complete menu', async () => {
    await i18n.changeLanguage('zh')
    storeMocks.settings = {
      computerAwakeMode: 'auto',
      keepComputerAwakeWhileAgentsRun: true
    }
    awakeMocks.status = { mode: 'auto', active: true }

    render(<CaffeinateStatusSegment iconOnly={false} />)

    const trigger = await screen.findByRole('button', {
      name: '防止电脑休眠，智能体 · 生效中'
    })
    expect(trigger.textContent).toContain('智能体')
    expect(screen.getByRole('tooltip').textContent).toContain(getAgentAwakeLidNote())

    const menu = screen.getByRole('menu')
    await waitFor(() => expect(menu.textContent).toContain('防止电脑休眠'))
    expect(menu.textContent).toContain('智能体 · 生效中')
    const [onItem, agentItem, offItem] = screen.getAllByRole('menuitemradio') as [
      HTMLElement,
      HTMLElement,
      HTMLElement
    ]
    expect(within(onItem).getByText('开启')).toBeTruthy()
    expect(within(onItem).getByText('始终防止此电脑进入睡眠状态')).toBeTruthy()
    expect(within(agentItem).getByText('智能体')).toBeTruthy()
    expect(within(agentItem).getByText('智能体工作时防止电脑进入睡眠状态')).toBeTruthy()
    expect(within(offItem).getByText('关闭')).toBeTruthy()
    expect(within(offItem).getByText('允许系统正常进入睡眠状态')).toBeTruthy()
  })
})
