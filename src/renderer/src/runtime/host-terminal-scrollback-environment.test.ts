import { describe, expect, it, vi } from 'vitest'
import {
  hostScrollbackEnvironmentId,
  resetHostTerminalScrollbackHydrationForTests,
  startHostTerminalScrollbackHydration,
  type HostTerminalScrollbackHydrationDeps
} from './host-terminal-scrollback-hydration'
import type { OrcadDeploymentLink } from '../../../shared/runtime-environments'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('../web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => null
}))

const PORTS = { localPort: 6768, remotePort: 6768 }
const ENVIRONMENTS: { id: string; orcadDeployment?: OrcadDeploymentLink }[] = [
  { id: 'env-wsl', orcadDeployment: { ...PORTS, kind: 'wsl', distro: 'Ubuntu' } },
  {
    id: 'env-ssh-orcad',
    orcadDeployment: { ...PORTS, kind: 'ssh', sshTargetId: 't', sshTargetGeneration: 1 }
  },
  { id: 'env-paired-web' }
]
const owner = (environmentId: string | null) => ({ kind: 'resolved' as const, environmentId })

describe('which host serves a pane its stored scrollback', () => {
  it('is only a WSL host', () => {
    expect(hostScrollbackEnvironmentId(owner('env-wsl'), ENVIRONMENTS)).toBe('env-wsl')
    expect(hostScrollbackEnvironmentId(owner('env-ssh-orcad'), ENVIRONMENTS)).toBeNull()
    expect(hostScrollbackEnvironmentId(owner('env-paired-web'), ENVIRONMENTS)).toBeNull()
    expect(hostScrollbackEnvironmentId(owner(null), ENVIRONMENTS)).toBeNull()
    expect(hostScrollbackEnvironmentId({ kind: 'ambiguous' }, ENVIRONMENTS)).toBeNull()
    // Before the environment list loads there is nothing to hold for.
    expect(hostScrollbackEnvironmentId(owner('env-wsl'), undefined)).toBeNull()
    expect(hostScrollbackEnvironmentId(owner('env-wsl'), [])).toBeNull()
  })

  it.each(['env-ssh-orcad', 'env-paired-web'])(
    'holds no %s tab for a placeholder and asks that host nothing',
    (environmentId) => {
      resetHostTerminalScrollbackHydrationForTests()
      const deps: HostTerminalScrollbackHydrationDeps = {
        getTabState: () => ({
          layout: {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null,
            scrollbackRefsByLeafId: { 'leaf-1': `v1-${'c'.repeat(32)}` }
          },
          localOnly: undefined
        }),
        resolveEnvironmentId: () => hostScrollbackEnvironmentId(owner(environmentId), ENVIRONMENTS),
        hasLocalSnapshot: vi.fn(() => false),
        peekHostSupportsRead: vi.fn(() => true),
        warmHostSupportsRead: vi.fn(async () => true),
        readHostSnapshot: vi.fn(async () => 'history'),
        isTabMounted: () => false,
        storeLocalOnly: vi.fn()
      }
      expect(startHostTerminalScrollbackHydration('tab-1', 'wt-1', deps)).toBeNull()
      expect(deps.peekHostSupportsRead).not.toHaveBeenCalled()
      expect(deps.warmHostSupportsRead).not.toHaveBeenCalled()
      expect(deps.readHostSnapshot).not.toHaveBeenCalled()
      expect(deps.hasLocalSnapshot).not.toHaveBeenCalled()
    }
  )
})
