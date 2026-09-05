import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams
} from './worktree-create-payload'

describe('worktree startup activation intent', () => {
  it.each(['', 'codex'])(
    'preserves background intent for command %j on both transports',
    (command) => {
      const startup = { command, activate: false, env: { PROJECT: 'fixture' } }
      const request = { repoId: 'repo', name: 'draft', startup }
      const attempt = { name: 'draft' }
      expect(buildLocalWorktreeCreateArgs(request, attempt).startup).toEqual(startup)
      expect(buildRuntimeWorktreeCreateParams(request, attempt)).toMatchObject({
        startupCommand: command,
        startupEnv: startup.env,
        startupActivate: false,
        activate: false
      })
    }
  )

  it('suppresses native activation only when completion owns the handoff', () => {
    const request = { repoId: 'repo', name: 'draft', startup: { command: 'codex' } }
    expect(buildLocalWorktreeCreateArgs(request, { name: 'draft' }, true).startup).toEqual({
      command: 'codex',
      activate: false
    })
    expect(buildLocalWorktreeCreateArgs(request, { name: 'draft' }).startup).toEqual({
      command: 'codex'
    })
  })

  it('waits for provisioning and suppresses host-built draft activation on capable runtimes', () => {
    const request = { repoId: 'repo', name: 'draft', options: { startupDraft: 'task' } }
    expect(buildRuntimeWorktreeCreateParams(request, { name: 'draft' }, true)).toMatchObject({
      startupDraft: 'task',
      startupActivate: false,
      activate: false,
      awaitTerminalProvisioning: true
    })
    expect(buildRuntimeWorktreeCreateParams(request, { name: 'draft' })).not.toHaveProperty(
      'awaitTerminalProvisioning'
    )
  })

  it('keeps ordinary foreground creation compatible when activation intent is absent', () => {
    const payload = buildRuntimeWorktreeCreateParams(
      { repoId: 'repo', name: 'draft', startup: { command: 'codex' } },
      { name: 'draft' }
    )
    expect(payload).toMatchObject({ startupCommand: 'codex', activate: true })
    expect(payload).not.toHaveProperty('startupActivate')
  })

  it('does not synthesize startup or activation for checkout-only preparation', () => {
    const payload = buildRuntimeWorktreeCreateParams(
      { repoId: 'repo', name: 'draft', createdWithAgent: 'codex' },
      { name: 'draft' }
    )
    expect(payload).not.toHaveProperty('startupCommand')
    expect(payload).not.toHaveProperty('startupActivate')
    expect(payload).not.toHaveProperty('activate')
  })
})
