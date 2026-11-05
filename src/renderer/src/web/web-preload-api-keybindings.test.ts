import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../../shared/keybindings'
import { installApi } from './web-preload-api-test-harness'

describe('web keybindings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('roundtrips old arrays, new claims, explicit conflicts, masks/reset and pruning', async () => {
    const { api, storage } = await installApi('MacIntel')
    const toggle = 'terminal.toggleNativeChat'
    const navigation = 'worktree.navigateDown'
    const aliases = ['Mod+Shift+J', 'Mod+Alt+Y']
    const seed = (value: unknown) =>
      storage.setItem('orca.web.keybindings.v1', JSON.stringify(value))
    const effective = async () =>
      getEffectiveKeybindingsForAction(toggle, 'darwin', (await api.keybindings.reload()).overrides)
    await api.keybindings.setAction({ actionId: navigation, bindings: aliases })
    expect(await effective()).toEqual([])
    seed({ keybindings: { [navigation]: aliases } })
    expect((await api.keybindings.get()).overrides).toEqual({ [navigation]: aliases })
    await api.keybindings.setAction({ actionId: navigation, bindings: [] })
    expect(await effective()).toEqual(['Mod+Shift+J'])
    await api.keybindings.setAction({ actionId: toggle, bindings: [] })
    expect(await effective()).toEqual([])
    await api.keybindings.setAction({ actionId: toggle, bindings: null })
    expect(await effective()).toEqual(['Mod+Shift+J'])
    await api.keybindings.setAction({ actionId: navigation, bindings: null })
    expect(await effective()).toEqual([])
    await expect(
      api.keybindings.setAction({ actionId: toggle, bindings: aliases })
    ).rejects.toThrow('conflicts')
    seed({
      version: 1,
      keybindings: { [navigation]: ['Mod+Alt+Y'], [toggle]: ['Mod+Alt+Y'] },
      platforms: { darwin: { [navigation]: [] } }
    })
    const unchanged = storage.getItem('orca.web.keybindings.v1')
    await expect(
      api.keybindings.setAction({ actionId: navigation, bindings: null })
    ).rejects.toThrow('conflicts')
    expect(storage.getItem('orca.web.keybindings.v1')).toBe(unchanged)
    seed({ keybindings: { [navigation]: ['Mod+Shift+J', 'Mod+P'] } })
    expect((await api.keybindings.reload()).overrides).toEqual({})
    expect(await effective()).toEqual(['Mod+Shift+J'])
    const win = await installApi('Windows NT 10.0')
    const saved = await win.api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: aliases
    })
    expect(saved.overrides['worktree.palette']).toEqual(aliases)
    expect(getEffectiveKeybindingsForAction(toggle, saved.platform, saved.overrides)).toEqual([
      'Mod+Shift+F11',
      'Mod+Shift+J'
    ])
  })
})
