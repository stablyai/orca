// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { ManagedRuntimeInstallRow } from './ManagedRuntimeInstallRow'

const base: ManagedRuntimeInstallState = {
  agent: 'antigravity',
  revision: 1,
  available: true,
  version: '1.5.0',
  downloadBytes: 98_000_000,
  installedVersion: null,
  installedCurrent: false,
  canRemove: false,
  source: null,
  operation: null
}

function status(state: ManagedRuntimeInstallState): HTMLElement {
  const { getByRole } = render(
    <ManagedRuntimeInstallRow
      observation={{
        kind: 'active',
        subject: { target: { kind: 'local' }, runtimeId: null, agent: state.agent },
        snapshot: { kind: 'known', state },
        removable: true
      }}
      agentLabel="Antigravity"
    >
      {(line, actions) => (
        <div>
          {line}
          {actions}
        </div>
      )}
    </ManagedRuntimeInstallRow>
  )
  return getByRole('status')
}

/** What the live region announces: its text without the parts hidden from screen readers. */
function spoken(element: HTMLElement): string {
  const copy = element.cloneNode(true)
  if (!(copy instanceof HTMLElement)) {
    throw new Error('expected the status line to clone as an element')
  }
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
  return copy.textContent ?? ''
}

/** The status text a sighted user sees, which is also its hover title. */
function shown(element: HTMLElement): string | null {
  return element.querySelector('[title]')?.getAttribute('title') ?? null
}

afterEach(cleanup)

describe('ManagedRuntimeInstallRow status', () => {
  it('shows short copy but announces the agent while verifying', () => {
    const line = status({
      ...base,
      operation: {
        id: 'op-1',
        kind: 'install',
        phase: 'verifying',
        downloadedBytes: 98_000_000,
        totalBytes: 98_000_000
      }
    })
    expect(shown(line)).not.toContain('Antigravity')
    expect(spoken(line)).toContain('Antigravity')
  })

  it("shows short copy but announces the agent when the host's own copy runs", () => {
    const line = status({ ...base, source: 'external' })
    expect(shown(line)).not.toContain('Antigravity')
    expect(spoken(line)).toContain('Antigravity')
  })

  it('announces the visible text when it already reads on its own', () => {
    const line = status({
      ...base,
      operation: {
        id: 'op-1',
        kind: 'install',
        phase: 'extracting',
        downloadedBytes: 98_000_000,
        totalBytes: 98_000_000
      }
    })
    const text = shown(line)
    expect(text).not.toBeNull()
    expect(spoken(line).startsWith(text ?? '')).toBe(true)
  })
})
