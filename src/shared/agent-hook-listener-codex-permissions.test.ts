import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

function permissionEvent(permissionMode: unknown, toolName = 'Bash') {
  return {
    paneKey: PANE_KEY,
    payload: {
      hook_event_name: 'PermissionRequest',
      permission_mode: permissionMode,
      tool_name: toolName,
      tool_input: { command: 'sleep 10' }
    }
  }
}

describe('Codex live permission mode', () => {
  it('keeps noninteractive permission hooks working without creating a human approval card', () => {
    const state = createHookListenerState()
    const result = normalizeHookPayload(
      state,
      'codex',
      permissionEvent('bypassPermissions'),
      'production'
    )
    expect(result?.payload).toMatchObject({
      state: 'working',
      toolName: 'Bash',
      toolInput: 'sleep 10'
    })
    expect(result?.payload.interactivePrompt).toBeUndefined()
    expect(result?.codexNonInteractivePermission).toBe(true)
  })

  it.each([undefined, null, 'default', 'acceptEdits', 'plan', 'dontAsk', 'unknown', true])(
    'preserves human attention without explicit noninteractive proof (%s)',
    (mode) => {
      const result = normalizeHookPayload(
        createHookListenerState(),
        'codex',
        permissionEvent(mode),
        'production'
      )
      expect(result?.payload.state).toBe('waiting')
      expect(result?.payload.interactivePrompt).toContain('approval')
      expect(result?.codexNonInteractivePermission).toBeUndefined()
    }
  )

  it.each(['PreToolUse', 'PermissionRequest'])(
    'preserves a question in bypass mode on %s',
    (eventName) => {
      const event = permissionEvent('bypassPermissions', 'request_user_input')
      event.payload.hook_event_name = eventName
      const result = normalizeHookPayload(createHookListenerState(), 'codex', event, 'production')
      expect(result?.payload.state).toBe('waiting')
      expect(result?.payload.interactivePrompt).toBeDefined()
      expect(result?.codexNonInteractivePermission).toBeUndefined()
    }
  )

  it('uses each hook mode, including an in-session switch back to human approval', () => {
    const state = createHookListenerState()
    for (const mode of ['default', 'bypassPermissions', 'default']) {
      const result = normalizeHookPayload(state, 'codex', permissionEvent(mode), 'production')
      expect(result?.payload.state).toBe(mode === 'default' ? 'waiting' : 'working')
      expect(Boolean(result?.payload.interactivePrompt)).toBe(mode === 'default')
    }
  })

  it('ignores envelope proof that was not derived from the live hook mode', () => {
    const result = normalizeHookPayload(
      createHookListenerState(),
      'codex',
      {
        ...permissionEvent('default'),
        codexNonInteractivePermission: true
      },
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.codexNonInteractivePermission).toBeUndefined()
  })

  it('does not apply Codex permission semantics to another provider', () => {
    const result = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      permissionEvent('bypassPermissions'),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.codexNonInteractivePermission).toBeUndefined()
  })
})
