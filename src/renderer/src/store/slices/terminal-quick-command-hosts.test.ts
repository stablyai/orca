import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'

import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { stubRuntimeEnvironmentBridge } from '../../runtime/runtime-environment-bridge-fixture'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const savedCommand: TerminalQuickCommand = {
  id: 'remote-build',
  label: 'Remote build',
  action: 'terminal-command',
  command: 'pnpm build',
  appendEnter: true,
  scope: { type: 'global' }
}

function success(result: unknown) {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function installRuntime(supported = true): ReturnType<typeof vi.fn> {
  const call = vi.fn(({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'status.get') {
      return Promise.resolve(
        success({
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: supported ? [TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY] : []
        })
      )
    }
    if (method === 'settings.getTerminalQuickCommands') {
      return Promise.resolve(success({ terminalQuickCommands: [savedCommand] }))
    }
    if (method === 'settings.updateTerminalQuickCommands') {
      const mutation = (params as { mutation: { command?: TerminalQuickCommand } }).mutation
      return Promise.resolve(
        success({ terminalQuickCommands: mutation.command ? [mutation.command] : [] })
      )
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  stubRuntimeEnvironmentBridge({ call })
  return call
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
})

describe('terminal quick command host collections', () => {
  it('does not let an older load overwrite a concurrent mutation', async () => {
    let resolveLoad: (value: ReturnType<typeof success>) => void = () => undefined
    const staleLoad = new Promise<ReturnType<typeof success>>((resolve) => {
      resolveLoad = resolve
    })
    const edited = { ...savedCommand, command: 'pnpm test' }
    const call = vi.fn(({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'status.get') {
        return Promise.resolve(
          success({
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: [TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY]
          })
        )
      }
      if (method === 'settings.getTerminalQuickCommands') {
        return staleLoad
      }
      if (method === 'settings.updateTerminalQuickCommands') {
        return Promise.resolve(success({ terminalQuickCommands: [edited] }))
      }
      throw new Error(`Unexpected method: ${method} ${String(params)}`)
    })
    stubRuntimeEnvironmentBridge({ call })
    const store = createTestStore()

    const load = store.getState().loadRuntimeTerminalQuickCommands('env-race', { force: true })
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'settings.getTerminalQuickCommands' })
      )
    )
    await store.getState().upsertTerminalQuickCommand('runtime:env-race', edited)
    resolveLoad(success({ terminalQuickCommands: [savedCommand] }))
    await load

    expect(store.getState().runtimeTerminalQuickCommands.get('env-race')?.commands).toEqual([
      edited
    ])
  })

  it('drops cached commands before revalidating a new connection', async () => {
    installRuntime()
    const store = createTestStore()
    await store.getState().loadRuntimeTerminalQuickCommands('env-1')

    store.getState().clearRuntimeEnvironmentStatus('env-1')
    const reload = store.getState().loadRuntimeTerminalQuickCommands('env-1')

    expect(store.getState().runtimeTerminalQuickCommands.get('env-1')).toMatchObject({
      commands: [],
      ready: false,
      supported: null
    })
    await reload
  })
})
