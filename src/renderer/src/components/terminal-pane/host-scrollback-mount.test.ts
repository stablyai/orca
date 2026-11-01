// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { OrcadDeploymentLink } from '../../../../shared/runtime-environments'
import { resetHostTerminalScrollbackHydrationForTests } from '@/runtime/host-terminal-scrollback-hydration'
import { useHostTerminalScrollbackHold } from './use-host-terminal-scrollback-hold'
import { resolveLeafScrollbackBuffers } from './leaf-scrollback-resolution'

const LEAF = '11111111-1111-4111-8111-111111111111'
const REF = `v1-${'d'.repeat(32)}`

type MountStore = {
  runtimeEnvironments: { id: string; orcadDeployment?: OrcadDeploymentLink }[]
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  localOnlyScrollbackByTabId: Record<string, Record<string, string> | undefined>
  setTabLocalOnlyScrollback: (tabId: string, buffers: Record<string, string> | null) => void
}

const WSL_HOST = {
  id: 'env-wsl',
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 6768, remotePort: 6768 }
} satisfies MountStore['runtimeEnvironments'][number]

const store = vi.hoisted((): MountStore => ({
  runtimeEnvironments: [],
  terminalLayoutsByTabId: {},
  localOnlyScrollbackByTabId: {},
  setTabLocalOnlyScrollback: () => {}
}))
const rpc = vi.hoisted((): { known: boolean | undefined; call: ReturnType<typeof vi.fn> } => ({
  known: undefined,
  call: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdForWorkspaceOwner: () => ({ kind: 'resolved', environmentId: 'env-wsl' })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  peekRuntimeEnvironmentCapability: () => rpc.known,
  runtimeEnvironmentSupportsCapability: async () => {
    rpc.known = true
    return true
  }
}))

function mountLayout(layout: TerminalLayoutSnapshot): void {
  store.terminalLayoutsByTabId['tab-1'] = layout
}

beforeEach(() => {
  resetHostTerminalScrollbackHydrationForTests()
  // Only a WSL host serves moved panes their history.
  store.runtimeEnvironments = [WSL_HOST]
  store.terminalLayoutsByTabId = {}
  store.localOnlyScrollbackByTabId = {}
  store.setTabLocalOnlyScrollback = (tabId, buffers) => {
    store.localOnlyScrollbackByTabId[tabId] = buffers ?? undefined
  }
  rpc.known = undefined
  rpc.call.mockReset()
  rpc.call.mockResolvedValue({ buffer: 'moved history\r\n' })
  Reflect.set(window, 'api', { session: { hasTerminalScrollback: () => false } })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('a moved pane mounting on its host', () => {
  it('reads the host snapshot before mount and hands it to the replay', async () => {
    // Moved panes opened with only a fresh prompt.
    const layout: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      scrollbackRefsByLeafId: { [LEAF]: REF }
    }
    mountLayout(layout)
    const { result } = renderHook(() => useHostTerminalScrollbackHold('tab-1', 'wt-1'))
    expect(result.current).toBe(true)
    await waitFor(() => expect(result.current).toBe(false))
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-wsl' },
      'session.readTerminalScrollback',
      expect.objectContaining({ ref: REF }),
      expect.anything()
    )
    // What restoreTerminalPaneLayout replays into xterm on mount.
    expect(
      resolveLeafScrollbackBuffers({
        shared: layout,
        localOnly: store.localOnlyScrollbackByTabId['tab-1']
      })
    ).toEqual({ [LEAF]: 'moved history\r\n' })
  })

  it('never reads for a pane bound to a terminal, which is why a move carries no binding', () => {
    mountLayout({
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      scrollbackRefsByLeafId: { [LEAF]: REF },
      ptyIdsByLeafId: { [LEAF]: 'wt-1@@81c7100a' }
    })
    const { result } = renderHook(() => useHostTerminalScrollbackHold('tab-1', 'wt-1'))
    expect(result.current).toBe(false)
    expect(rpc.call).not.toHaveBeenCalled()
  })
})
