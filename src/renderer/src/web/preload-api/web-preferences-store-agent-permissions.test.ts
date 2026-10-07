import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_STORAGE_KEY } from './web-storage'
import {
  PERMISSION_AGENT_IDS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from '../../../../shared/tui-agent-permissions'

const runtimeMock = vi.hoisted(() => {
  const state: { reply: Record<string, unknown>; environment: { id: string } | null } = {
    reply: {},
    environment: null
  }
  return state
})

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: vi.fn(async () => ({ settings: runtimeMock.reply }))
}))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireActiveEnvironmentOrNull: () => runtimeMock.environment
}))

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value)
  }
}

// The web client keeps its own settings in localStorage; blobs saved before the permission mode
// was typed carry the flag inside each agent's arguments.
describe('web stored settings agent permissions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lifts a stored legacy profile into the typed mode once and saves it', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        agentDefaultArgs: {
          claude: '--model opus',
          codex: '--dangerously-bypass-approvals-and-sandbox -m o3'
        }
      })
    )
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionMode).toBe('bypass')
    expect(settings.agentPermissionModeOverrides).toMatchObject({ claude: 'ask' })
    expect(settings.agentDefaultArgs?.claude).toBe('--model opus')
    expect(settings.agentDefaultArgs?.codex).toBe('-m o3')
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(saved.agentPermissionMode).toBe('bypass')
    expect(getStoredSettings()).toEqual(settings)
  })

  // An older build shipped a shorter Devin bypass; the web blob reads it as Yolo and launches it as is.
  it('reads the older Devin bypass as Yolo', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentDefaultArgs: { devin: '--permission-mode bypass' } })
    )
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionModeOverrides?.devin).toBeUndefined()
    expect(settings.agentDefaultArgs?.devin).toBe('--permission-mode bypass')
  })

  // After a downgrade the older client writes the flag back; the stored mode must not latch over it.
  it('lifts a flag written back into a typed blob, and saves it', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        agentPermissionMode: 'ask',
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox -m o3' }
      })
    )
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionModeOverrides).toEqual({ codex: 'bypass' })
    expect(settings.agentDefaultArgs?.codex).toBe('-m o3')
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(saved.agentDefaultArgs.codex).toBe('-m o3')
  })

  it('keeps a stored mode it does not know instead of re-migrating', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentPermissionMode: 'accept-edits', agentDefaultArgs: { claude: '' } })
    )
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionModeOverrides).toEqual({})
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(saved.agentPermissionMode).toBe('accept-edits')
  })

  // The host serves the web bundle, so a host downgrade hands this blob to an older bundle, which
  // reads a missing agent entry as "launch with the bypass flag".
  it('saves explicit empty launch text so an older bundle launches a fresh Manual client in Manual', async () => {
    const { createWebSettingsApi } = await import('./web-settings-api')
    const api = createWebSettingsApi().settings

    await api?.set({ agentPermissionMode: 'ask' })
    // A write that names only some agents keeps the others spelled out.
    await api?.set({ agentDefaultArgs: { claude: '--model opus' } })

    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(saved.agentPermissionMode).toBe('ask')
    expect(saved.agentDefaultArgs.claude).toBe('--model opus')
    const bypassing = PERMISSION_AGENT_IDS.filter((agent) => {
      const args = saved.agentDefaultArgs ?? {}
      const env = saved.agentDefaultEnv ?? {}
      const launchArgs = Object.hasOwn(args, agent) ? args[agent] : YOLO_TUI_AGENT_ARGS[agent]
      const launchEnv = Object.hasOwn(env, agent) ? env[agent] : YOLO_TUI_AGENT_ENV[agent]
      const flag = YOLO_TUI_AGENT_ARGS[agent]
      return (flag && launchArgs?.includes(flag)) || launchEnv?.GOOSE_MODE === 'auto'
    })
    expect(bypassing).toEqual([])
  })

  it('gives a fresh client the Yolo default', async () => {
    const { getStoredSettings } = await import('./web-preferences-store')

    const settings = getStoredSettings()

    expect(settings.agentPermissionMode).toBe('bypass')
    expect(settings.agentDefaultArgs).toMatchObject({ claude: '', codex: '' })
    expect(settings.agentDefaultEnv).toEqual({ goose: {} })
  })

  // The host replies to settings.update with its own launch-ready args (flag inline).
  it('keeps its own agent launch settings when merging a paired host reply', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentDefaultArgs: { claude: '--model opus' } })
    )
    runtimeMock.environment = { id: 'env-1' }
    runtimeMock.reply = {
      compactWorktreeCards: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions --model opus', codex: '' }
    }
    const { getStoredSettings, syncRuntimeBackedSettings } = await import('./web-preferences-store')

    const next = await syncRuntimeBackedSettings(
      { compactWorktreeCards: true },
      getStoredSettings()
    )

    expect(next.compactWorktreeCards).toBe(true)
    expect(next.agentDefaultArgs?.claude).toBe('--model opus')
    expect(next.agentPermissionModeOverrides).toMatchObject({ claude: 'ask' })
    expect(next.agentPermissionModeOverrides?.codex).toBeUndefined()
    runtimeMock.environment = null
  })
})
