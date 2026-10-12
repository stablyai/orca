// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armWorkspaceDeleteConfirmation,
  cancelWorkspaceDeleteConfirmation,
  confirmWorkspaceDeleteConfirmation,
  getArmedWorkspaceDeleteIdentity,
  WORKSPACE_DELETE_CONFIRM_TIMEOUT_MS
} from './workspace-delete-confirmation'

vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

function deps(watch: { onChange: (() => void) | null } = { onChange: null }) {
  return {
    timeoutMs: WORKSPACE_DELETE_CONFIRM_TIMEOUT_MS,
    watchActiveWorkspace: (onChange: () => void) => {
      watch.onChange = onChange
      return () => {
        watch.onChange = null
      }
    }
  }
}

describe('workspace delete confirmation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cancelWorkspaceDeleteConfirmation()
    vi.useRealTimers()
  })

  it('arms one identity and confirms only that identity', () => {
    armWorkspaceDeleteConfirmation('local|repo::/a', deps())
    expect(confirmWorkspaceDeleteConfirmation('local|repo::/b')).toBe(false)
    expect(getArmedWorkspaceDeleteIdentity()).toBe('local|repo::/a')
    expect(confirmWorkspaceDeleteConfirmation('local|repo::/a')).toBe(true)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
  })

  it('disarms after the timeout', () => {
    armWorkspaceDeleteConfirmation('local|repo::/a', deps())
    vi.advanceTimersByTime(WORKSPACE_DELETE_CONFIRM_TIMEOUT_MS - 1)
    expect(getArmedWorkspaceDeleteIdentity()).toBe('local|repo::/a')
    vi.advanceTimersByTime(1)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
  })

  it('disarms when the active workspace changes and stops watching', () => {
    const watch = { onChange: null as (() => void) | null }
    armWorkspaceDeleteConfirmation('local|repo::/a', deps(watch))
    watch.onChange?.()
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
    expect(watch.onChange).toBeNull()
  })

  it('disarms on Escape without consuming the key', () => {
    armWorkspaceDeleteConfirmation('local|repo::/a', deps())
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(event)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores other keys', () => {
    armWorkspaceDeleteConfirmation('local|repo::/a', deps())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(getArmedWorkspaceDeleteIdentity()).toBe('local|repo::/a')
  })
})
