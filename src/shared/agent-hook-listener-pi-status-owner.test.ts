import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { hasLivePiStatusOwner } from './agent-hook-listener/pi-status-owner-liveness'
import { PANE_KEY } from './agent-hook-listener-test-harness'

const PERMISSION_REQUEST = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'exec',
  tool_input: { command: 'ls' }
}

function normalizeDevin(owner: Record<string, string>): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(
    createHookListenerState(),
    'devin',
    { paneKey: PANE_KEY, payload: PERMISSION_REQUEST, ...owner },
    'production'
  )
}

// Why: Windows Devin hooks cannot probe liveness in cmd, so they name the owner for the listener.
describe('Devin hook events naming a Pi status owner (#22011)', () => {
  it('keeps events that name no owner', () => {
    expect(normalizeDevin({})?.payload).toMatchObject({ agentType: 'devin', state: 'waiting' })
  })

  it.each(['ORCA_PI_STATUS_OWNED', 'ORCA_PRIME_AGENT_STATUS_OWNED'])(
    'drops events while the %s owner is alive',
    (key) => {
      expect(normalizeDevin({ [key]: String(process.pid) })).toBeNull()
    }
  )

  it('keeps events whose recorded owner has exited', () => {
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
    expect(normalizeDevin({ ORCA_PI_STATUS_OWNED: String(exited) })?.payload).toMatchObject({
      state: 'waiting'
    })
  })

  // Why: `0`, `00` and `-1` address process groups, so a probe of them would always succeed.
  it.each(['', '0', '00', '-1', ' 1', '1.5', 'not-a-pid'])(
    'never probes a malformed owner %j',
    (value) => {
      const probe = vi.fn(() => true)
      expect(hasLivePiStatusOwner({ ORCA_PI_STATUS_OWNED: value }, probe)).toBe(false)
      expect(probe).not.toHaveBeenCalled()
      expect(normalizeDevin({ ORCA_PI_STATUS_OWNED: value })).not.toBeNull()
    }
  )

  it('leaves other agents alone', () => {
    const result = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
        ORCA_PI_STATUS_OWNED: String(process.pid)
      },
      'production'
    )
    expect(result).not.toBeNull()
  })
})
