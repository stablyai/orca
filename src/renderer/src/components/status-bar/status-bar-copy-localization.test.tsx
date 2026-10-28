// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { i18n } from '@/i18n/i18n'
import { SshStatusSegment } from './SshStatusSegment'

type StoreState = {
  sshConnectionStates: Map<string, { status: SshConnectionStatus }>
  sshTargetLabels: Map<string, string>
}

let storeState: StoreState = {
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map()
}

vi.mock('../../store', () => {
  const state = (): Record<string, unknown> => ({
    ...storeState,
    settings: null,
    repos: [],
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    setRuntimeEnvironmentStatus: vi.fn(),
    hydrateRuntimeEnvironmentStatuses: vi.fn(),
    setActiveView: vi.fn(),
    openSettingsTarget: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    fetchRuntimeEnvironmentRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    fetchWorktreeLineage: vi.fn()
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

function setSshTargets(
  entries: { id: string; label: string; status: SshConnectionStatus }[]
): void {
  storeState = {
    sshConnectionStates: new Map(entries.map((entry) => [entry.id, { status: entry.status }])),
    sshTargetLabels: new Map(entries.map((entry) => [entry.id, entry.label]))
  }
}

function triggerText(): string {
  const content = document.createElement('div')
  content.innerHTML = screen.getByRole('button').innerHTML
  content.querySelectorAll('[aria-hidden="true"]').forEach((element) => element.remove())
  return content.textContent ?? ''
}

describe('status-bar copy under a non-English UI language', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ja')
  })

  afterEach(() => {
    cleanup()
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates the connected host count next to the translated aria label', () => {
    setSshTargets([
      { id: 'ssh-1', label: 'builder', status: 'connected' },
      { id: 'ssh-2', label: 'openclaw', status: 'connected' }
    ])
    render(<SshStatusSegment compact={false} iconOnly={false} />)

    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('リモートホスト接続状態')
    expect(triggerText()).toContain('2 台のホスト')
  })

  it('keeps the translated connected count while a host is connecting', () => {
    setSshTargets([{ id: 'ssh-1', label: 'builder', status: 'connecting' }])
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(triggerText()).toContain('0 台のホスト')
    expect(triggerText()).not.toContain('接続中…')
  })
})
