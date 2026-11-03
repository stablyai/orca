// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)
afterEach(() => vi.restoreAllMocks())

const entries: AgentPickerEntry[] = (['codex', 'claude'] as const).map((agent) => ({
  agent: agent,
  label: agent === 'codex' ? 'Codex' : 'Claude',
  rows: [{ agent: agent, kind: 'chat' }],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'default', label: 'Default', isDefault: true, efforts: [] }]
  }
}))

function show(controlled = false) {
  const launched = vi.fn()
  const changed = vi.fn()
  function Menu() {
    const [open, setOpen] = useState(true)
    return (
      <TooltipProvider>
        <DropdownMenu
          open={controlled ? open : undefined}
          defaultOpen
          modal={false}
          onOpenChange={(next) => {
            changed(next)
            setOpen(next)
          }}
        >
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={entries} runLaunch={launched} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  }
  render(<Menu />)
  return { launched, changed }
}

it('moves one agent per Up/Down press, including after returning from its submenu', async () => {
  const { launched } = show()
  const user = userEvent.setup()
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  const claude = screen.getByRole('menuitem', { name: /^Claude/ })
  codex.focus()
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(document.activeElement).toBe(claude))
  await user.keyboard('{ArrowUp}')
  await waitFor(() => expect(document.activeElement).toBe(codex))
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('menu', { name: 'Configure Codex' })).toBeTruthy()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Search Codex models…'))
  )
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Configure Codex' }))
  )
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(screen.getByPlaceholderText('Search Codex models…'))
  await user.keyboard('{Escape}')
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(document.activeElement).toBe(claude))
  expect(launched).not.toHaveBeenCalled()
})

it.each(['hover', 'click'] as const)(
  'focuses model search when the chevron opens by %s',
  async (method) => {
    const { launched } = show()
    const user = userEvent.setup({ skipHover: method === 'click' })
    const segment = screen.getByRole('button', { name: 'Configure Codex' })
    await user[method](segment)
    const search = screen.getByPlaceholderText<HTMLInputElement>('Search Codex models…')
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.pointerMove(segment, { pointerType: 'mouse' })
    expect(document.activeElement).toBe(search)
    await user.keyboard('missing')
    expect(search.value).toBe('missing')
    expect(screen.getByText('No models match your search.')).toBeTruthy()
    expect(launched).not.toHaveBeenCalled()
  }
)

it('returns from empty search with Left Arrow, then reopens and navigates the main menu', async () => {
  const { launched, changed } = show()
  const user = userEvent.setup()
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  codex.focus()
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(screen.getByPlaceholderText('Search Codex models…'))
  await user.keyboard('{ArrowLeft}')
  expect(screen.queryByRole('menu', { name: 'Configure Codex' })).toBeNull()
  expect(document.activeElement).toBe(codex)
  expect(screen.getByRole('menu', { name: 'New tab' })).toBeTruthy()
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(screen.getByPlaceholderText('Search Codex models…'))
  await user.keyboard('{ArrowLeft}{ArrowDown}')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Claude/ }))
  )
  expect(changed).not.toHaveBeenCalled()
  expect(launched).not.toHaveBeenCalled()
})

it('keeps Left Arrow editing a typed search and returns after the search is cleared', async () => {
  show()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Configure Codex' }))
  const search = screen.getByPlaceholderText<HTMLInputElement>('Search Codex models…')
  await user.keyboard('query{ArrowLeft}')
  expect(search.selectionStart).toBe(4)
  expect(document.activeElement).toBe(search)
  expect(screen.getByRole('menu', { name: 'Configure Codex' })).toBeTruthy()
  await user.clear(search)
  fireEvent.keyDown(search, { key: 'ArrowLeft', isComposing: true })
  expect(screen.getByRole('menu', { name: 'Configure Codex' })).toBeTruthy()
  await user.keyboard('{ArrowLeft}')
  expect(screen.queryByRole('menu', { name: 'Configure Codex' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Codex/ }))
})

it.each([false, true])(
  'closes a controlled=%s menu once after default launch',
  async (controlled) => {
    const { launched, changed } = show(controlled)
    await userEvent.setup().click(screen.getByRole('menuitem', { name: /^Codex/ }))
    expect(launched).toHaveBeenCalledExactlyOnceWith(entries[0].rows[0], undefined)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  }
)

it('only opens setup from the chevron segment, never from hovering the agent name or icon', async () => {
  const { launched } = show()
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  const claude = screen.getByRole('menuitem', { name: /^Claude/ })
  vi.useFakeTimers()
  try {
    for (const target of [codex, screen.getByText('Codex'), codex.querySelector('svg')!]) {
      fireEvent.pointerMove(target, { pointerType: 'mouse' })
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(screen.queryByRole('menu', { name: 'Configure Codex' })).toBeNull()
      expect(document.activeElement).toBe(codex)
    }

    fireEvent.pointerOver(screen.getByRole('button', { name: 'Configure Codex' }), {
      pointerType: 'mouse'
    })
    expect(screen.getByRole('menu', { name: 'Configure Codex' })).toBeTruthy()

    fireEvent.pointerMove(screen.getByText('Claude'), { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(document.activeElement).toBe(claude)
    expect(screen.queryByRole('menu', { name: 'Configure Claude' })).toBeNull()
    expect(screen.queryByRole('menu', { name: 'Configure Codex' })).toBeNull()
    expect(launched).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps wheel highlighting on the agent under the resting pointer without opening setup', () => {
  const { launched } = show()
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  const claude = screen.getByRole('menuitem', { name: /^Claude/ })
  const menu = screen.getByRole('menu', { name: 'New tab' })
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback))
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(claude)
  codex.focus()
  const wheel = new WheelEvent('wheel', { bubbles: true })
  Object.defineProperties(wheel, { clientX: { value: 10 }, clientY: { value: 40 } })
  fireEvent(menu, wheel)
  fireEvent.pointerMove(screen.getByText('Codex'), {
    pointerType: 'mouse',
    clientX: 10,
    clientY: 40
  })
  fireEvent.scroll(menu)
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  expect(document.activeElement).toBe(claude)
  expect(screen.queryByRole('menu', { name: /^Configure/ })).toBeNull()
  expect(launched).not.toHaveBeenCalled()
})

it('does not launch when a row press is released over the submenu trigger', async () => {
  const { launched } = show()
  const configure = screen.getByRole('button', { name: 'Configure Codex' })
  const row = screen.getByRole('menuitem', { name: /^Codex/ })
  const user = userEvent.setup()
  await user.pointer([
    { target: screen.getByText('Codex'), keys: '[MouseLeft>]' },
    { target: configure, keys: '[/MouseLeft]' }
  ])
  expect(launched).not.toHaveBeenCalled()
  await user.click(row.querySelector('span')!)
  expect(launched).toHaveBeenCalledOnce()
})

it('preserves search focus while crossing another row toward a left-opening submenu', async () => {
  const { launched } = show()
  await userEvent.setup().hover(screen.getByRole('button', { name: 'Configure Codex' }))
  const panel = screen.getByRole('menu', { name: 'Configure Codex' })
  const search = screen.getByPlaceholderText('Search Codex models…')
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  const claude = screen.getByRole('menuitem', { name: /^Claude/ })
  const menu = screen.getByRole('menu', { name: 'New tab' })
  panel.dataset.side = 'left'
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 20, 300, 180))
  for (const clientX of [500, 460]) {
    fireEvent.pointerMove(menu, { pointerType: 'mouse', clientX, clientY: 45 })
  }
  fireEvent.pointerOut(codex, {
    pointerType: 'mouse',
    clientX: 450,
    clientY: 50,
    relatedTarget: claude
  })
  fireEvent.pointerMove(claude, { pointerType: 'mouse', clientX: 440, clientY: 60 })
  expect(document.activeElement).toBe(search)
  expect(panel.dataset.state).toBe('open')
  fireEvent.pointerMove(claude, { pointerType: 'mouse', clientX: 460, clientY: 230 })
  expect(document.activeElement).toBe(claude)
  expect(screen.queryByRole('menu', { name: /^Configure/ })).toBeNull()
  expect(launched).not.toHaveBeenCalled()
})
