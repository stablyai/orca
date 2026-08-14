import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(options?.[name] ?? match))
}))

import {
  connectedHostCountLabel,
  connectingHostsLabel,
  workspaceSyncProblemLabel
} from './ssh-status-segment-copy'

describe('ssh status segment copy', () => {
  it('keeps the host noun singular for a lone connected host', () => {
    expect(connectedHostCountLabel(0)).toBe('0 hosts')
    expect(connectedHostCountLabel(1)).toBe('1 host')
    expect(connectedHostCountLabel(4)).toBe('4 hosts')
  })

  it('distinguishes a sync conflict from a sync failure', () => {
    expect(connectingHostsLabel()).toBe('Connecting…')
    expect(workspaceSyncProblemLabel('conflict')).toBe('Workspace conflict')
    expect(workspaceSyncProblemLabel('error')).toBe('Workspace sync error')
  })
})
