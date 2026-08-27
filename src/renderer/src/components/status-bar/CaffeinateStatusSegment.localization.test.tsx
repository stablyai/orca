// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import { getAgentAwakeModeLabel, getAgentAwakeTitle } from '../settings/agent-awake-copy'
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

const localeCopy = [
  [
    'es',
    {
      title: 'Mantener la computadora activa',
      on: 'Activado',
      auto: 'Agente',
      off: 'Desactivado',
      active: 'Activo',
      inactive: 'Inactivo',
      ariaLabel: 'Mantener la computadora activa, Desactivado · Inactivo',
      onDescription: 'Mantener esta computadora activa en todo momento',
      autoDescription: 'Mantener la computadora activa mientras un agente está trabajando',
      offDescription: 'Permitir que el sistema entre en suspensión normalmente'
    }
  ],
  [
    'ja',
    {
      title: 'コンピュータをスリープさせない',
      on: 'オン',
      auto: 'Agent',
      off: 'オフ',
      active: 'アクティブ',
      inactive: '非アクティブ',
      ariaLabel: 'コンピュータをスリープさせない、オフ · 非アクティブ',
      onDescription: 'このコンピュータを常にスリープさせない',
      autoDescription: 'Agent の作業中はスリープさせない',
      offDescription: '通常のシステムスリープを許可する'
    }
  ],
  [
    'ko',
    {
      title: '컴퓨터 절전 방지',
      on: '켜짐',
      auto: '에이전트',
      off: '꺼짐',
      active: '활성',
      inactive: '비활성',
      ariaLabel: '컴퓨터 절전 방지, 꺼짐 · 비활성',
      onDescription: '이 컴퓨터가 절전 모드로 전환되지 않도록 항상 유지',
      autoDescription: '에이전트가 작업하는 동안 절전 모드로 전환되지 않도록 유지',
      offDescription: '시스템의 기본 절전 동작 허용'
    }
  ],
  [
    'zh',
    {
      title: '防止电脑休眠',
      on: '开启',
      auto: '智能体',
      off: '关闭',
      active: '生效中',
      inactive: '未生效',
      ariaLabel: '防止电脑休眠，关闭 · 未生效',
      onDescription: '始终防止此电脑进入睡眠状态',
      autoDescription: '智能体工作时防止电脑进入睡眠状态',
      offDescription: '允许系统正常进入睡眠状态'
    }
  ]
] as const

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
  it.each(localeCopy)('%s resolves the shared title, modes, and activity', async (locale, copy) => {
    await i18n.changeLanguage(locale)

    expect({
      title: getAgentAwakeTitle(),
      on: getAgentAwakeModeLabel('on'),
      auto: getAgentAwakeModeLabel('auto'),
      off: getAgentAwakeModeLabel('off'),
      active: translate('auto.components.status.bar.CaffeinateStatusSegment.active', 'Active'),
      inactive: translate(
        'auto.components.status.bar.CaffeinateStatusSegment.inactive',
        'Inactive'
      ),
      ariaLabel: translate(
        'auto.components.status.bar.CaffeinateStatusSegment.ariaLabel',
        '{{title}}, {{status}}',
        {
          title: getAgentAwakeTitle(),
          status: `${getAgentAwakeModeLabel('off')} · ${translate(
            'auto.components.status.bar.CaffeinateStatusSegment.inactive',
            'Inactive'
          )}`
        }
      ),
      onDescription: translate(
        'auto.components.status.bar.CaffeinateStatusSegment.onDescription',
        'Keep this computer awake continuously'
      ),
      autoDescription: translate(
        'auto.components.status.bar.CaffeinateStatusSegment.autoDescription',
        'Stay awake while an agent is working'
      ),
      offDescription: translate(
        'auto.components.status.bar.CaffeinateStatusSegment.offDescription',
        'Allow normal system sleep behavior'
      )
    }).toEqual(copy)
  })

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
