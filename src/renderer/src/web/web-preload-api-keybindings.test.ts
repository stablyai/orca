import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction
} from '../../../shared/keybindings'
import { installApi, installBrowserGlobals } from './web-preload-api-test-harness'

describe('web keybindings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('migrates existing Mac search bindings once, preserving custom and disabled shortcuts', async () => {
    const { storage } = installBrowserGlobals('MacIntel')
    storage.setItem('orca.web.settings.v1', '{}')
    storage.setItem(
      'orca.web.keybindings.v1',
      JSON.stringify({
        keybindings: { 'terminal.clear': [] },
        platforms: { win32: { 'worktree.palette': ['Mod+Shift+J'] } }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': []
    })
    await window.api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Mod+Alt+J']
    })
    installWebPreloadApi()
    const snapshot = await window.api.keybindings.get()
    expect(snapshot.overrides).toEqual({ 'worktree.palette': ['Mod+Alt+J'], 'terminal.clear': [] })
    expect(snapshot.platformOverrides.win32).toEqual({ 'worktree.palette': ['Mod+Shift+J'] })
    await window.api.keybindings.setAction({ actionId: 'worktree.palette', bindings: null })
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+K'],
      'terminal.clear': []
    })
  })

  it('retains legacy Mac shortcuts for a profile without saved settings', async () => {
    const { storage } = installBrowserGlobals('MacIntel')
    storage.setItem('orca.web.onboarding.v1', '{}')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
  })

  it.each([
    ['Linux x86_64', 'linux'],
    ['Windows NT 10.0', 'win32']
  ] as const)(
    'preserves existing %s web shortcuts and resets to Ctrl+K',
    async (userAgent, platform) => {
      const { storage } = installBrowserGlobals(userAgent)
      storage.setItem('orca.web.settings.v1', '{}')
      storage.setItem('orca.web.searchKeybindingSeed.v1', 'done')
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const old = await window.api.keybindings.get()
      expect(getEffectiveKeybindingsForAction('worktree.palette', platform, old.overrides)).toEqual(
        ['Mod+Shift+J']
      )
      expect(getEffectiveKeybindingsForAction('terminal.clear', platform, old.overrides)).toEqual([
        'Mod+K'
      ])
      const reset = await window.api.keybindings.setAction({
        actionId: 'worktree.palette',
        bindings: null
      })
      expect(
        getEffectiveKeybindingsForAction('worktree.palette', platform, reset.overrides)
      ).toEqual(['Mod+K'])
      expect(getEffectiveKeybindingsForAction('terminal.clear', platform, reset.overrides)).toEqual(
        []
      )
    }
  )

  it.each(['common', 'platform'])(
    'keeps an explicit %s palette chord ahead of the generated clear shortcut',
    async (section) => {
      const { storage } = installBrowserGlobals('MacIntel')
      const bindings = { 'worktree.palette': ['Cmd+K'] }
      storage.setItem(
        'orca.web.keybindings.v1',
        JSON.stringify(
          section === 'common' ? { keybindings: bindings } : { platforms: { darwin: bindings } }
        )
      )
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const snapshot = await window.api.keybindings.get()
      expect(snapshot.overrides).toEqual({
        'worktree.palette': ['Cmd+K'],
        'terminal.clear': []
      })
      expect(snapshot.diagnostics).toEqual([])
    }
  )

  it('keeps saved Ctrl+K clear bindings reachable after the earlier Mac rollout', async () => {
    const { storage } = installBrowserGlobals('Windows NT 10.0')
    storage.setItem('orca.web.searchKeybindingSeed.v1', 'done')
    storage.setItem(
      'orca.web.keybindings.v1',
      JSON.stringify({ platforms: { win32: { 'terminal.clear': ['Ctrl+K'] } } })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    installWebPreloadApi()
    const { overrides } = await window.api.keybindings.get()
    const ctrlK = { key: 'k', control: true }
    expect(keybindingMatchesAction('terminal.clear', ctrlK, 'win32', overrides)).toBe(true)
    expect(keybindingMatchesAction('worktree.palette', ctrlK, 'win32', overrides)).toBe(false)
    await expect(
      window.api.keybindings.setAction({ actionId: 'worktree.palette', bindings: null })
    ).rejects.toThrow('conflicts')
  })

  it('leaves an invalid Mac section intact and retries after repair', async () => {
    const { storage } = installBrowserGlobals('MacIntel')
    const raw = '{"platforms":{"darwin":null}}'
    storage.setItem('orca.web.keybindings.v1', raw)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect(storage.getItem('orca.web.keybindings.v1')).toBe(raw)
    storage.setItem('orca.web.keybindings.v1', '{"platforms":{"darwin":{}}}')
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
  })

  it('keeps the web API available after a migration write fails and retries on launch', async () => {
    const { storage } = installBrowserGlobals('MacIntel')
    storage.setItem('orca.web.settings.v1', '{}')
    const write = vi.spyOn(storage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
    write.mockRestore()
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
  })

  it.each(['MacIntel', 'Windows NT 10.0'])(
    'keeps a fresh %s web profile on the new defaults after saving settings and restarting',
    async (userAgent) => {
      const { api, storage } = await installApi(userAgent)
      expect((await api.keybindings.get()).overrides).toEqual({})
      storage.setItem('orca.web.settings.v1', '{}')
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      expect((await window.api.keybindings.get()).overrides).toEqual({})
    }
  )

  it('does not overwrite unreadable shortcuts while upgrading an existing web profile', async () => {
    const { storage } = installBrowserGlobals('MacIntel')
    storage.setItem('orca.web.keybindings.v1', '{invalid')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect(storage.getItem('orca.web.keybindings.v1')).toBe('{invalid')
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
    storage.setItem('orca.web.keybindings.v1', '{}')
    installWebPreloadApi()
    expect((await window.api.keybindings.get()).overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
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
