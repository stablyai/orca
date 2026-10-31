import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotStatus } from '../../../../shared/copilot-inline-completion-types'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const NOT_INSTALLED: CopilotStatus = {
  installed: false,
  kind: null,
  message: '',
  busy: false,
  user: null,
  signInFailed: false
}
const INSTALLED: CopilotStatus = { ...NOT_INSTALLED, installed: true }

function setup(initial: CopilotStatus) {
  let push: (status: CopilotStatus) => void = () => {}
  let onFocus: () => void = () => {}
  const api = {
    status: vi.fn().mockResolvedValue(initial),
    onStatus: vi.fn((callback: (status: CopilotStatus) => void) => {
      push = callback
      return () => {}
    })
  }
  vi.stubGlobal('window', {
    api: { copilotCompletion: api },
    addEventListener: (_type: string, handler: () => void) => (onFocus = handler)
  })
  return { api, push: (status: CopilotStatus) => push(status), focus: () => onFocus() }
}

async function loadStatusModule() {
  vi.resetModules()
  return import('./copilot-status')
}

beforeEach(() => {
  toastError.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copilot status store', () => {
  it('reveals a server installed after startup on the next window focus', async () => {
    const env = setup(NOT_INSTALLED)
    const store = await loadStatusModule()
    store.ensureCopilotStatusSubscription()
    await vi.waitFor(() => expect(env.api.status).toHaveBeenCalledTimes(1))
    expect(store.getInstalledCopilotStatus()).toBeNull()

    env.api.status.mockResolvedValue(INSTALLED)
    env.focus()
    await vi.waitFor(() => expect(store.getInstalledCopilotStatus()).toEqual(INSTALLED))

    env.focus()
    expect(env.api.status).toHaveBeenCalledTimes(2)
  })

  it('toasts once when a sign-in failure is pushed', async () => {
    const env = setup(INSTALLED)
    const store = await loadStatusModule()
    store.ensureCopilotStatusSubscription()
    env.push({ ...INSTALLED, signInFailed: true })
    env.push({ ...INSTALLED, signInFailed: true, busy: true })
    expect(toastError).toHaveBeenCalledTimes(1)
    env.push({ ...INSTALLED, signInFailed: false })
    env.push({ ...INSTALLED, signInFailed: true })
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it('patches the live status instead of restoring a stale snapshot', async () => {
    const env = setup({ ...INSTALLED, signInFailed: true })
    const store = await loadStatusModule()
    store.ensureCopilotStatusSubscription()
    env.push({ ...INSTALLED, signInFailed: true })
    env.push({ ...INSTALLED, signInFailed: false })
    store.patchCopilotStatus({ user: 'octocat', kind: 'Normal' })
    expect(store.getInstalledCopilotStatus()).toMatchObject({
      user: 'octocat',
      kind: 'Normal',
      signInFailed: false
    })
  })
})
