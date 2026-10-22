// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'

type AwakeMocks = {
  status: { mode: string; active: boolean }
  sleepDisabled: 'yes' | 'no' | 'unknown'
  unsubscribe: ReturnType<typeof vi.fn>
}

const storeMocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, updateSettings: vi.fn() }
})

const awakeMocks = vi.hoisted((): AwakeMocks => ({
  status: { mode: 'off', active: false },
  sleepDisabled: 'no',
  unsubscribe: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeMocks.state)
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

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const LID_NOTE_MAC =
  'Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.'
const HOLD_SYSTEM = 'Kept awake by a system setting'
const HOLD_LID_CLOSED = 'This Mac (where Orca runs) stays awake with the lid closed.'
const HOLD_UNCHECKED = "Couldn't check this Mac's sleep setting"

type Mode = 'off' | 'auto' | 'on'
type HoldCase = 'none' | 'unchecked' | 'system'

const MODES: readonly { mode: Mode; label: string; orcaActive: boolean }[] = [
  { mode: 'off', label: 'Off', orcaActive: false },
  { mode: 'auto', label: 'Agent', orcaActive: true },
  { mode: 'on', label: 'On', orcaActive: true }
]

const HOLD_CASES: readonly { hold: HoldCase; sleepDisabled: 'yes' | 'no' | 'unknown' }[] = [
  { hold: 'none', sleepDisabled: 'no' },
  { hold: 'unchecked', sleepDisabled: 'unknown' },
  { hold: 'system', sleepDisabled: 'yes' }
]

function expectedCell(
  hold: HoldCase,
  modeLabel: string,
  orcaActive: boolean
): {
  aria: string
  barLabel: string
  tooltip: string
  menuNote: string | null
  lit: boolean
} {
  const status = `${modeLabel} · ${orcaActive ? 'Active' : 'Inactive'}`
  const todayAria = `Keep computer awake, ${status}`
  if (hold === 'system') {
    return {
      aria: `Keep computer awake, ${HOLD_SYSTEM}, ${status}`,
      barLabel: 'Awake',
      tooltip: `${HOLD_SYSTEM}. ${HOLD_LID_CLOSED} Orca keep-awake: ${status}.`,
      menuNote: `${HOLD_SYSTEM}. ${HOLD_LID_CLOSED}`,
      lit: true
    }
  }
  if (hold === 'unchecked') {
    return {
      aria: `Keep computer awake, ${HOLD_UNCHECKED}, ${status}`,
      barLabel: modeLabel,
      tooltip: `${todayAria}. ${HOLD_UNCHECKED}.`,
      menuNote: HOLD_UNCHECKED,
      lit: orcaActive
    }
  }
  return {
    aria: todayAria,
    barLabel: modeLabel,
    tooltip: `${todayAria}. ${LID_NOTE_MAC}`,
    menuNote: null,
    lit: orcaActive
  }
}

async function settleHoldRead(): Promise<void> {
  await waitFor(() => expect(window.api.agentAwake.getSystemSleepHold).toHaveBeenCalled())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setStore(mode: Mode, extra: Record<string, unknown> = {}): void {
  storeMocks.state = {
    settings: { computerAwakeMode: mode, keepComputerAwakeWhileAgentsRun: mode !== 'off' },
    updateSettings: storeMocks.updateSettings,
    ...extra
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA)
  awakeMocks.sleepDisabled = 'no'
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentAwake: {
        getStatus: vi.fn().mockImplementation(() => Promise.resolve(awakeMocks.status)),
        onChanged: vi.fn().mockReturnValue(awakeMocks.unsubscribe),
        getSystemSleepHold: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ sleepDisabled: awakeMocks.sleepDisabled, observedAt: Date.now() })
          )
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CaffeinateStatusSegment system sleep hold', () => {
  describe.each(HOLD_CASES)('hold $hold', ({ hold, sleepDisabled }) => {
    it.each(MODES)('renders the cell for mode $mode', async ({ mode, label, orcaActive }) => {
      const expected = expectedCell(hold, label, orcaActive)
      setStore(mode)
      awakeMocks.status = { mode, active: orcaActive }
      awakeMocks.sleepDisabled = sleepDisabled

      render(<CaffeinateStatusSegment iconOnly={false} />)

      await settleHoldRead()
      await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(expected.tooltip))
      const trigger = screen.getByRole('button', { name: expected.aria })
      expect(trigger.textContent).toBe(expected.barLabel)
      const icon = trigger.querySelector('svg')
      const dot = trigger.querySelector('span[aria-hidden]')
      expect(icon?.getAttribute('class')?.includes('text-foreground')).toBe(expected.lit)
      expect(dot?.getAttribute('class')?.includes('bg-foreground')).toBe(expected.lit)

      const menu = screen.getByRole('menu')
      const status = `${label} · ${orcaActive ? 'Active' : 'Inactive'}`
      expect(menu.textContent).toContain(`Keep computer awake${status}`)
      if (expected.menuNote) {
        expect(menu.textContent).toContain(expected.menuNote)
      } else {
        expect(menu.textContent).not.toContain(HOLD_SYSTEM)
        expect(menu.textContent).not.toContain(HOLD_UNCHECKED)
      }
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
      for (const description of [
        'Keep this computer awake continuously',
        'Stay awake while an agent is working',
        'Allow normal system sleep behavior'
      ]) {
        expect(within(menu).getByText(description)).toBeTruthy()
      }
    })
  })

  it.each([
    [
      'ja',
      'システム設定によりスリープしません。蓋を閉じても、Orca が動いているこの Mac はスリープしません。',
      'Orca のスリープ防止: オフ · 非アクティブ。'
    ],
    [
      'zh',
      '系统设置使此 Mac 不会休眠。运行 Orca 的这台 Mac 在合盖后也不会休眠。',
      'Orca 防休眠：关闭 · 未生效。'
    ]
  ])(
    'joins the held tooltip and menu note with the %s full stop and no ASCII gap',
    async (locale, note, ownStatus) => {
      await i18n.changeLanguage(locale)
      setStore('off')
      awakeMocks.status = { mode: 'off', active: false }
      awakeMocks.sleepDisabled = 'yes'

      render(<CaffeinateStatusSegment iconOnly={false} />)

      await waitFor(() =>
        expect(screen.getByRole('tooltip').textContent).toBe(`${note}${ownStatus}`)
      )
      expect(screen.getByRole('menu').textContent).toContain(note)
      expect(document.body.textContent).not.toContain('. ')
    }
  )

  it.each([
    ['ja', 'この Mac のスリープ設定を確認できませんでした'],
    ['zh', '无法检查此 Mac 的休眠设置']
  ])(
    'joins the unchecked tooltip with the %s full stop and no ASCII punctuation',
    async (locale, unchecked) => {
      await i18n.changeLanguage(locale)
      setStore('off')
      awakeMocks.status = { mode: 'off', active: false }
      awakeMocks.sleepDisabled = 'unknown'

      render(<CaffeinateStatusSegment iconOnly={false} />)

      await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain(unchecked))
      const tooltip = screen.getByRole('tooltip').textContent ?? ''
      expect(tooltip.endsWith(`。${unchecked}。`)).toBe(true)
      expect(tooltip).not.toContain('. ')
      expect(tooltip.endsWith('.')).toBe(false)
    }
  )

  it('never renders the Mac lid note while the hold is system', async () => {
    setStore('off')
    awakeMocks.status = { mode: 'off', active: false }
    awakeMocks.sleepDisabled = 'yes'

    render(<CaffeinateStatusSegment iconOnly={false} />)
    await screen.findByRole('button', { name: /Kept awake by a system setting/ })

    expect(document.body.textContent).not.toContain('closing the lid still puts this Mac to sleep')
  })

  it('shows today strings on a non-Mac host even when the read is unknown', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    setStore('off')
    awakeMocks.status = { mode: 'off', active: false }
    awakeMocks.sleepDisabled = 'unknown'

    render(<CaffeinateStatusSegment iconOnly={false} />)

    await waitFor(() => expect(window.api.agentAwake.getSystemSleepHold).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Keep computer awake, Off · Inactive' })).toBeTruthy()
    expect(document.body.textContent).not.toContain(HOLD_UNCHECKED)
  })

  it('says it could not check, not that the Mac sleeps, when the read rejects on a Mac', async () => {
    setStore('off')
    awakeMocks.status = { mode: 'off', active: false }
    vi.mocked(window.api.agentAwake.getSystemSleepHold!).mockRejectedValue(new Error('ipc closed'))

    render(<CaffeinateStatusSegment iconOnly={false} />)

    await screen.findByRole('button', {
      name: `Keep computer awake, ${HOLD_UNCHECKED}, Off · Inactive`
    })
    expect(document.body.textContent).not.toContain('closing the lid still puts this Mac to sleep')
  })

  it('keeps today strings on a non-Mac host when the read rejects', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    setStore('off')
    awakeMocks.status = { mode: 'off', active: false }
    vi.mocked(window.api.agentAwake.getSystemSleepHold!).mockRejectedValue(new Error('ipc closed'))

    render(<CaffeinateStatusSegment iconOnly={false} />)

    await waitFor(() => expect(window.api.agentAwake.getSystemSleepHold).toHaveBeenCalled())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByRole('button', { name: 'Keep computer awake, Off · Inactive' })).toBeTruthy()
    expect(document.body.textContent).not.toContain(HOLD_UNCHECKED)
  })

  it('hides the bar label in icon-only mode but keeps the lit icon while held', async () => {
    setStore('off')
    awakeMocks.status = { mode: 'off', active: false }
    awakeMocks.sleepDisabled = 'yes'

    render(<CaffeinateStatusSegment iconOnly />)

    const trigger = await screen.findByRole('button', { name: /Kept awake by a system setting/ })
    expect(trigger.textContent).toBe('')
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-foreground')
  })

  it('still shows the local hold while the active workspace is an SSH workspace', async () => {
    setStore('off', {
      activeWorktreeId: 'ssh-1::/srv/app',
      repos: [{ id: 'ssh-1', connectionId: 'ssh-1' }],
      sshConnectionStates: new Map([['ssh-1', { status: 'connected' }]])
    })
    awakeMocks.status = { mode: 'off', active: false }
    awakeMocks.sleepDisabled = 'yes'

    render(<CaffeinateStatusSegment iconOnly={false} />)

    const trigger = await screen.findByRole('button', { name: /Kept awake by a system setting/ })
    expect(trigger.textContent).toBe('Awake')
    expect(screen.getByRole('tooltip').textContent).toContain('This Mac (where Orca runs)')
  })
})
