// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import {
  applyNativeChatModelPreset,
  currentNativeChatModelPreset
} from './native-chat-model-presets'

const { errorToast, infoToast } = vi.hoisted(() => ({ errorToast: vi.fn(), infoToast: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: errorToast, info: infoToast } }))

function snapshot(
  model = 'strong',
  effort = 'high',
  transport: 'catalog' | 'agent-session' = 'agent-session'
): SessionOptionDescriptor[] {
  return [
    {
      id: 'model',
      label: 'Model',
      category: 'model',
      transport,
      settable: true,
      valueSource: 'applied',
      kind: {
        type: 'select',
        currentValue: model,
        choices: [
          { value: 'strong', label: 'Strong' },
          { value: 'quick', label: 'Quick' }
        ]
      }
    },
    {
      id: 'effort',
      label: 'Effort',
      category: 'thought_level',
      transport,
      settable: true,
      valueSource: 'applied',
      kind: {
        type: 'select',
        currentValue: effort,
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    }
  ]
}

function session(initial = snapshot()) {
  let current = initial
  const writes: [string, string | boolean][] = []
  const setOption = vi.fn(async (id: string, value: string | boolean) => {
    writes.push([id, value])
    current = current.map((option) => {
      if (option.id === id) {
        return {
          ...option,
          kind:
            option.kind.type === 'select'
              ? { ...option.kind, currentValue: String(value) }
              : { ...option.kind, currentValue: Boolean(value) }
        }
      }
      return id === 'model' && option.id === 'effort' && option.kind.type === 'select'
        ? { ...option, kind: { ...option.kind, currentValue: 'low' } }
        : option
    })
    return { snapshot: current }
  })
  const surface: SessionOptionsSurface = {
    getSnapshot: () => current,
    subscribe: () => () => {},
    setOption,
    invokeAction: async () => ({ snapshot: current })
  }
  return {
    surface,
    writes,
    setOption,
    replace: (next: SessionOptionDescriptor[]) => {
      current = next
    }
  }
}

function View({
  source,
  scope = 'codex:local',
  working = false
}: {
  source: ReturnType<typeof session>
  scope?: string
  working?: boolean
}) {
  return (
    <TooltipProvider>
      <div data-native-chat-root="true">
        <div data-native-chat-composer-scope="composer">
          <textarea aria-label="Prompt" defaultValue="Keep my draft" />
          <NativeChatSessionOptionPickers
            surface={source.surface}
            snapshot={source.surface.getSnapshot()}
            isWorking={working}
            presetScope={scope}
          />
        </div>
      </div>
    </TooltipProvider>
  )
}

function pressPreset(slot = 1, extra: KeyboardEventInit = {}) {
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: ['¡', '™', '£'][slot - 1],
    code: `Digit${slot}`,
    metaKey: false,
    altKey: true,
    ...extra
  })
}

function openPicker() {
  const isMac = navigator.userAgent.includes('Mac')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: 'm',
    code: 'KeyM',
    ctrlKey: true,
    shiftKey: isMac,
    altKey: !isMac
  })
}

async function saveSlot(slot = 1) {
  fireEvent.click(
    await screen.findByRole('button', { name: `Slot ${slot}` }),
    navigator.userAgent.includes('Mac') ? { altKey: true } : { ctrlKey: true }
  )
}

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
  localStorage.clear()
  useAppStore.setState({ keybindings: {} })
  errorToast.mockReset()
  infoToast.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([1, 2, 3])('restores preset %s after remount without changing the draft', async (slot) => {
  const source = session()
  const first = render(<View source={source} />)
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: 'M',
    code: 'KeyM',
    ctrlKey: true,
    shiftKey: true
  })
  await saveSlot(slot)
  first.unmount()
  source.replace(snapshot('quick', 'low'))
  render(<View source={source} />)
  pressPreset(slot, { metaKey: true })
  expect(source.writes).toEqual([])
  pressPreset(slot)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(prompt instanceof HTMLTextAreaElement && prompt.value).toBe('Keep my draft')
})

it.each(['codex:remote', 'claude:local'])(
  'keeps presets separate from %s without opening the picker for an empty slot',
  async (scope) => {
    const source = session()
    const view = render(<View source={source} />)
    openPicker()
    await saveSlot()
    view.unmount()
    render(<View source={source} scope={scope} />)
    pressPreset()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(infoToast).toHaveBeenCalled()
    expect(source.writes).toEqual([])
  }
)

it.each([1, 2, 3])('switches to saved preset %s when its button is clicked', async (slot) => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot(slot)
  fireEvent.click(screen.getByRole('button', { name: `Slot ${slot}` }))
  first.unmount()
  source.replace(snapshot('quick', 'low'))
  render(<View source={source} />)
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: 'M',
    code: 'KeyM',
    ctrlKey: true,
    shiftKey: true
  })
  fireEvent.click(await screen.findByRole('button', { name: `Slot ${slot}` }))
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the host CLI update available alongside saved presets', async () => {
  const source = session()
  const startUpdate = vi.fn()
  source.surface.cliUpdate = {
    agent: 'codex',
    phase: 'idle',
    start: startUpdate,
    openFailure: vi.fn()
  }
  render(<View source={source} />)
  openPicker()
  await saveSlot()
  fireEvent.click(await screen.findByRole('option', { name: 'Update Codex CLI for new models' }))
  expect(startUpdate).toHaveBeenCalledOnce()
  pressPreset()
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
})

it('uses remapped shortcuts and ignores repeat, composition, and keys from another pane', async () => {
  const source = session()
  useAppStore.setState({ keybindings: { 'chat.openModelPicker': ['Mod+Alt+K'] } })
  render(
    <>
      <View source={source} />
      <textarea aria-label="Other pane" />
    </>
  )
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  const key = { key: 'k', code: 'KeyK', metaKey: true, altKey: true }
  fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })
  fireEvent.keyDown(prompt, { ...key, isComposing: true })
  fireEvent.keyDown(prompt, { ...key, repeat: true })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Other pane' }), key)
  expect(screen.queryByRole('button', { name: 'Slot 1' })).toBeNull()
  fireEvent.keyDown(prompt, key)
  expect(await screen.findByRole('button', { name: 'Slot 1' })).toBeDefined()
})

it('blocks terminal preset changes while a turn runs', async () => {
  const source = session(snapshot('strong', 'high', 'catalog'))
  await expect(
    applyNativeChatModelPreset(
      source.surface,
      { model: 'strong', modelLabel: 'Strong', effort: 'high' },
      true
    )
  ).rejects.toThrow()
  expect(source.writes).toEqual([])
})

it('does not send a missing model and reports an unavailable effort after the model changes', async () => {
  const source = session()
  await expect(
    applyNativeChatModelPreset(source.surface, { model: 'missing', modelLabel: 'Missing' }, false)
  ).rejects.toThrow()
  expect(source.writes).toEqual([])
  source.setOption.mockImplementation(async () => ({
    snapshot: snapshot('strong', 'low').filter((entry) => entry.id !== 'effort')
  }))
  await expect(
    applyNativeChatModelPreset(
      source.surface,
      { model: 'strong', modelLabel: 'Strong', effort: 'high' },
      false
    )
  ).rejects.toThrow()
  expect(source.setOption.mock.calls).toEqual([['model', 'strong']])
})

it('holds later preset presses until both model and effort finish', async () => {
  const source = session()
  render(<View source={source} />)
  openPicker()
  await saveSlot()
  const pending = Promise.withResolvers<{ snapshot: SessionOptionDescriptor[] }>()
  source.setOption.mockImplementationOnce(() => pending.promise)
  pressPreset()
  pressPreset()
  expect(source.setOption.mock.calls).toEqual([['model', 'strong']])
  pending.resolve({ snapshot: snapshot() })
  await waitFor(() =>
    expect(source.setOption.mock.calls).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
})

it.each(['Linux', 'Windows'])('switches presets with Ctrl shortcuts on %s', async (platform) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
  const source = session()
  render(<View source={source} />)
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: 'm',
    code: 'KeyM',
    ctrlKey: true,
    altKey: true
  })
  await saveSlot()
  pressPreset(1, { key: '1', metaKey: false, ctrlKey: true })
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
})

it('clears a saved slot and reports storage failures', async () => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Slot 1' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear preset 1' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  first.unmount()
  const second = render(<View source={source} />)
  pressPreset()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(infoToast).toHaveBeenCalled()
  expect(source.writes).toEqual([])
  openPicker()
  const deniedStorage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError')
  })
  await saveSlot()
  expect(errorToast).toHaveBeenCalled()
  deniedStorage.mockRestore()
  second.unmount()
  render(<View source={source} />)
  pressPreset()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(infoToast).toHaveBeenCalled()
  expect(source.writes).toEqual([])
})

it('replaces a filled slot with modifier-click without switching the current model', async () => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot()
  first.unmount()
  source.replace(snapshot('quick', 'low'))
  render(<View source={source} />)
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
    key: 'M',
    code: 'KeyM',
    ctrlKey: true,
    shiftKey: true
  })
  await saveSlot()
  expect(source.writes).toEqual([])
  pressPreset()
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'quick'],
      ['effort', 'low']
    ])
  )
})

it.each([{}, { metaKey: true }])(
  'leaves an empty slot unassigned without Option (%j)',
  async (modifiers) => {
    const source = session()
    const first = render(<View source={source} />)
    openPicker()
    fireEvent.click(await screen.findByRole('button', { name: 'Slot 1' }), modifiers)
    first.unmount()
    render(<View source={source} />)
    pressPreset()
    expect(source.writes).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(infoToast).toHaveBeenCalled()
  }
)

it('moves an identical model and effort to another slot and preserves other presets', async () => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot(1)
  source.replace(snapshot('quick', 'low'))
  first.rerender(<View source={source} />)
  await saveSlot(3)
  source.replace(snapshot('strong', 'high'))
  first.rerender(<View source={source} />)
  await saveSlot(2)
  expect(source.writes).toEqual([])
  first.unmount()

  const second = render(<View source={source} />)
  pressPreset(1)
  expect(source.writes).toEqual([])
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(infoToast).toHaveBeenCalled()
  pressPreset(2)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
  second.unmount()
  render(<View source={source} />)
  pressPreset(3)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high'],
      ['model', 'quick'],
      ['effort', 'low']
    ])
  )
})

it('deduplicates older identical presets while keeping different efforts', async () => {
  localStorage.setItem(
    'orca.chat.modelPresets.v1:codex:local',
    JSON.stringify([
      { model: 'strong', modelLabel: 'Strong', effort: 'high' },
      { model: 'strong', modelLabel: 'Strong', effort: 'low' },
      { model: 'strong', modelLabel: 'Strong', effort: 'high' }
    ])
  )
  const source = session()
  render(<View source={source} />)
  pressPreset(3)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(source.writes).toEqual([])
  openPicker()
  expect(await screen.findByRole('button', { name: 'Slot 1', pressed: true })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Slot 2', pressed: false })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Slot 3', pressed: false })).toBeDefined()
  pressPreset(2)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'low']
    ])
  )
})

it('reports a failed preset switch without opening the model picker', async () => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot()
  first.unmount()
  source.replace(
    snapshot('quick', 'low').map((option) =>
      option.id === 'model' && option.kind.type === 'select'
        ? { ...option, kind: { ...option.kind, choices: [{ value: 'quick', label: 'Quick' }] } }
        : option
    )
  )
  render(<View source={source} />)
  pressPreset()
  await waitFor(() => expect(errorToast).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(source.writes).toEqual([])
})

it('keeps different reasoning efforts for the same model in separate slots', async () => {
  const source = session()
  const first = render(<View source={source} />)
  openPicker()
  await saveSlot(1)
  source.replace(snapshot('strong', 'low'))
  first.rerender(<View source={source} />)
  await saveSlot(2)
  first.unmount()
  const second = render(<View source={source} />)
  pressPreset(1)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
  second.unmount()
  render(<View source={source} />)
  pressPreset(2)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high'],
      ['model', 'strong'],
      ['effort', 'low']
    ])
  )
})

function speedSnapshot(value: string | boolean): SessionOptionDescriptor[] {
  return [
    ...snapshot(),
    {
      id: typeof value === 'boolean' ? 'fastMode' : 'serviceTier',
      label: 'Speed',
      transport: 'agent-session',
      settable: true,
      valueSource: 'applied',
      kind:
        typeof value === 'boolean'
          ? { type: 'boolean', currentValue: value }
          : {
              type: 'select',
              currentValue: value,
              choices: [
                { value: 'default', label: 'Standard' },
                { value: 'priority', label: 'Fast' },
                { value: 'flex', label: 'Flex' }
              ]
            }
    }
  ]
}

it.each(['priority', 'default', 'flex', true, false])(
  'saves and restores speed %s with model and effort',
  async (value) => {
    const source = session(speedSnapshot(value))
    const view = render(<View source={source} />)
    openPicker()
    await saveSlot(1)
    view.unmount()
    source.replace(speedSnapshot(typeof value === 'boolean' ? !value : 'default'))
    render(<View source={source} />)
    pressPreset(1)
    await waitFor(() =>
      expect(source.writes).toEqual([
        ['model', 'strong'],
        ['effort', 'high'],
        [typeof value === 'boolean' ? 'fastMode' : 'serviceTier', value]
      ])
    )
    expect(errorToast).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  }
)

it('keeps Fast on and off separate and moves only the identical full configuration', async () => {
  const source = session(speedSnapshot('priority'))
  const view = render(<View source={source} />)
  openPicker()
  await saveSlot(1)
  source.replace(speedSnapshot('default'))
  view.rerender(<View source={source} />)
  await saveSlot(2)
  source.replace(speedSnapshot('priority'))
  view.rerender(<View source={source} />)
  expect(screen.getByRole('button', { name: 'Slot 1', pressed: true })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Slot 2', pressed: false })).toBeDefined()
  await saveSlot(3)
  pressPreset(1)
  expect(source.writes).toEqual([])
  expect(infoToast).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Slot 2' }))
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high'],
      ['serviceTier', 'default']
    ])
  )
  view.unmount()
  render(<View source={source} />)
  pressPreset(3)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high'],
      ['serviceTier', 'default'],
      ['model', 'strong'],
      ['effort', 'high'],
      ['serviceTier', 'priority']
    ])
  )
})

it('preserves speed for older presets that did not save it', async () => {
  localStorage.setItem(
    'orca.chat.modelPresets.v1:codex:local',
    JSON.stringify([{ model: 'strong', modelLabel: 'Strong', effort: 'high' }, null, null])
  )
  const source = session(speedSnapshot('priority'))
  render(<View source={source} />)
  pressPreset(1)
  await waitFor(() =>
    expect(source.writes).toEqual([
      ['model', 'strong'],
      ['effort', 'high']
    ])
  )
  expect(
    source.surface.getSnapshot().find((entry) => entry.id === 'serviceTier')?.kind.currentValue
  ).toBe('priority')
})

it('restores speed when the model has no effort option', async () => {
  const source = session(speedSnapshot(false).filter((entry) => entry.id !== 'effort'))
  await applyNativeChatModelPreset(
    source.surface,
    {
      model: 'strong',
      modelLabel: 'Strong',
      speed: { id: 'fastMode', value: true }
    },
    false
  )
  expect(source.writes).toEqual([
    ['model', 'strong'],
    ['fastMode', true]
  ])
})

it('rejects speed unavailable on the target model instead of sending an unsupported value', async () => {
  const source = session(speedSnapshot('priority'))
  source.setOption.mockImplementation(async () => ({ snapshot: snapshot() }))
  await expect(
    applyNativeChatModelPreset(
      source.surface,
      {
        model: 'strong',
        modelLabel: 'Strong',
        speed: { id: 'serviceTier', value: 'priority', label: 'Fast' }
      },
      false
    )
  ).rejects.toThrow()
  expect(source.setOption.mock.calls).toEqual([['model', 'strong']])
})

it.each(['unknown', 'unconfirmed', 'action'] as const)(
  'does not save an %s Fast state',
  (state) => {
    const options = speedSnapshot(true)
    const speed = options[2]
    if (state === 'unknown') {
      speed.valueSource = 'unknown'
    }
    if (state === 'unconfirmed') {
      speed.valueSource = 'dispatched'
      speed.transport = 'catalog'
    }
    if (state === 'action') {
      speed.action = { type: 'toggle-command' }
    }
    expect(currentNativeChatModelPreset(options)).toBeNull()
  }
)
