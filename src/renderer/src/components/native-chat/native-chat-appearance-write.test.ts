import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(
  (): {
    state: {
      settings: GlobalSettings | null
      updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
    }
  } => ({ state: { settings: null, updateSettings: async () => {} } })
)

vi.mock('../../store', () => ({ useAppStore: { getState: () => mock.state } }))

import { writeNativeChatAppearance } from './native-chat-appearance-write'
import { writeNativeChatFontSize } from './native-chat-font-size-write'

beforeEach(() => {
  mock.state.settings = getDefaultSettings('/tmp')
})

describe('chat appearance write queue', () => {
  it('serializes card and zoom changes against the latest published settings', async () => {
    let releaseFirst: () => void = () => {}
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
      calls += 1
      if (calls === 1) {
        await firstWrite
      }
      mock.state.settings = { ...mock.state.settings!, ...updates }
    })
    mock.state.updateSettings = updateSettings
    const fromNewerVersion = { fontSize: 14, contrast: 151, futureSetting: 'keep' }
    mock.state.settings = {
      ...getDefaultSettings('/tmp'),
      nativeChatAppearance: fromNewerVersion
    }

    const cardWrite = writeNativeChatAppearance((current) => ({ ...current, codeFontSize: 16 }))
    const zoomWrite = writeNativeChatFontSize('increase')
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    releaseFirst()
    await Promise.all([cardWrite, zoomWrite])

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(mock.state.settings?.nativeChatAppearance).toEqual({
      contrast: 150,
      futureSetting: 'keep',
      codeFontSize: 16,
      fontSize: 15
    })
  })

  it('skips repeated writes at a zoom limit and still accepts the next reversal', async () => {
    const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
      mock.state.settings = { ...mock.state.settings!, ...updates }
    })
    mock.state.updateSettings = updateSettings
    mock.state.settings = {
      ...getDefaultSettings('/tmp'),
      nativeChatAppearance: { fontSize: 20 }
    }

    await writeNativeChatFontSize('increase')
    await writeNativeChatFontSize('increase')
    expect(updateSettings).not.toHaveBeenCalled()
    await writeNativeChatFontSize('decrease')
    await writeNativeChatFontSize('increase')
    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(mock.state.settings?.nativeChatAppearance).toEqual({ fontSize: 20 })
  })

  it('consumes chat size actions without changing saved size while terminal matching is active', async () => {
    const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
      mock.state.settings = { ...mock.state.settings!, ...updates }
    })
    mock.state.updateSettings = updateSettings
    mock.state.settings = {
      ...getDefaultSettings('/tmp'),
      nativeChatAppearance: {
        fontSize: 18,
        codeFontSize: 16,
        contrast: 125,
        matchTerminalInterface: true
      }
    }
    await writeNativeChatFontSize('increase')
    await writeNativeChatFontSize('decrease')
    await writeNativeChatFontSize('reset')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(mock.state.settings.nativeChatAppearance?.fontSize).toBe(18)
    mock.state.settings = {
      ...mock.state.settings,
      nativeChatAppearance: {
        ...mock.state.settings.nativeChatAppearance,
        matchTerminalInterface: false
      }
    }
    await writeNativeChatFontSize('increase')
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(mock.state.settings.nativeChatAppearance?.fontSize).toBe(19)
  })
})
