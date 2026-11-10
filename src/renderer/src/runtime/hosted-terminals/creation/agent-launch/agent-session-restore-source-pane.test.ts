import { describe, expect, it, vi } from 'vitest'
import { restoreSourcePaneOptions } from './agent-session-ensure-provider-session'

vi.mock('../../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

// The host keys its saved notes by its own tab, never the desktop mirror's.
describe('a saved restore source pane sent to its host', () => {
  it('names the host tab, not the mirror tab', async () => {
    expect(await restoreSourcePaneOptions('env-1', `web-terminal-host-tab:${LEAF}`)).toEqual({
      restoreSourcePaneKey: `host-tab:${LEAF}`
    })
  })
})
