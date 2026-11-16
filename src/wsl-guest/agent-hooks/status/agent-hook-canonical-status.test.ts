import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from '../server/agent-hook-server'
import {
  TMUX_TEST_ROOT,
  TMUX_TEST_ROWS,
  tmuxTestBody
} from '../../../shared/agent-hook-listener/presence/tmux-status.test-fixture'
const probe = vi.hoisted(() => vi.fn())
vi.mock('../../../shared/agent-hook-listener/presence/tmux-host-attachment-probe', () => ({
  probeTmuxHostAttachments: probe
}))

let server: RelayAgentHookServer
let directory: string
const forward = vi.fn()
const unavailable = vi.fn()
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-tmux-canonical-'))
  forward.mockClear()
  unavailable.mockClear()
  probe.mockResolvedValue({ clients: [{ pid: 101, pane: '%0' }], rows: TMUX_TEST_ROWS })
  server = new RelayAgentHookServer({
    endpointDir: directory,
    forward,
    forwardUnavailable: unavailable,
    getTmuxManagedPty: async () => TMUX_TEST_ROOT
  })
  await server.start({ publishEndpoint: false })
})
afterEach(() => {
  server.stop()
  rmSync(directory, { recursive: true, force: true })
})
async function post(body: unknown = tmuxTestBody(), source = 'opencode') {
  const coordinates = server.getCoordinates()
  return fetch(`http://127.0.0.1:${coordinates.port}/hook/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': coordinates.token },
    body: JSON.stringify(body)
  })
}
describe('relay canonical tmux ownership and replay', () => {
  it('replaces a legacy OpenCode 2 row with unavailable and preserves its launch identity', async () => {
    const body = tmuxTestBody()
    const { tmux: _tmux, ...legacy } = body
    expect((await post(legacy, 'opencode2')).status).toBe(204)
    probe.mockResolvedValue({ clients: [], rows: TMUX_TEST_ROWS })
    await post(body, 'opencode2')
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 2500 })
    forward.mockClear()
    unavailable.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
    expect(forward).not.toHaveBeenCalled()
    expect(unavailable.mock.lastCall?.[0]).toMatchObject({
      source: 'opencode2',
      tabId: 'tab-tmux',
      launchToken: 'generation',
      statusUnavailable: true
    })
  })
  it('derives first unavailable identity from the same outer inner observation', async () => {
    probe.mockResolvedValue({ clients: [{ pid: 101, pane: '%9' }], rows: TMUX_TEST_ROWS })
    await post(tmuxTestBody(), 'opencode2')
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 2500 })
    expect(unavailable.mock.lastCall?.[0]).toMatchObject({
      source: 'opencode2',
      tabId: 'tab-tmux',
      launchToken: 'generation'
    })
  })
})
