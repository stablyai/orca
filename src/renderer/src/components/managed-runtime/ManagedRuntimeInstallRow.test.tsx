// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { ManagedRuntimeInstallRow } from './ManagedRuntimeInstallRow'

const install = vi.hoisted(() => vi.fn<() => Promise<void>>())
vi.mock('@/runtime/hosts/installation/managed-runtime-install-status', () => ({
  installManagedRuntime: install,
  cancelManagedRuntimeInstall: vi.fn(),
  removeManagedRuntime: vi.fn()
}))

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

/** The status text a sighted user sees. */
function shown(element: HTMLElement): string | null {
  const text = element.querySelector('[title]')
  return text?.querySelector('[aria-hidden="true"]')?.textContent ?? text?.textContent ?? null
}

/** The hover title, which carries the full spoken status. */
function title(element: HTMLElement): string | null {
  return element.querySelector('[title]')?.getAttribute('title') ?? null
}

/** The line's parts, each drawing its separator dot in a left gutter. */
function parts(line: HTMLElement): HTMLElement[] {
  return Array.from(line.firstElementChild?.children ?? []).filter(
    (part): part is HTMLElement => part instanceof HTMLElement
  )
}

const failedInstall = {
  ...base,
  operation: {
    id: 'op-1',
    kind: 'install' as const,
    phase: 'failed' as const,
    downloadedBytes: 0,
    totalBytes: null,
    error: 'Network down.'
  }
}

afterEach(() => {
  cleanup()
  install.mockReset()
})

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
    expect(title(line)).toContain('Antigravity')
  })

  it("shows short copy but announces the agent when the host's own copy runs", () => {
    const line = status({ ...base, source: 'external' })
    expect(shown(line)).not.toContain('Antigravity')
    expect(spoken(line)).toContain('Antigravity')
    expect(title(line)).toContain('Antigravity')
  })
})

describe('ManagedRuntimeInstallRow layout', () => {
  it('wraps a reason instead of truncating it', () => {
    const line = status({ ...base, available: false })
    expect(line.firstElementChild?.className).toContain('flex-wrap')
    expect(line.querySelector('[title]')?.className).not.toContain('truncate')
  })

  it('keeps a plain status on one line', () => {
    const line = status({ ...base, installedVersion: '1.5.0', installedCurrent: true })
    expect(line.firstElementChild?.className).not.toContain('flex-wrap')
    expect(line.querySelector('[title]')?.className).toContain('truncate')
  })

  it('reads an error whole and starts the action after it on a new line', () => {
    const line = status(failedInstall)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Network down.')
    const part = alert.parentElement
    expect(part?.className).toContain('basis-full')
    expect(part?.nextElementSibling?.querySelector('button')?.textContent).toBe('Try again')
    expect(line.firstElementChild?.className).toContain('flex-wrap')
  })

  it("shows a local install error whole and frees Install once it's refused", async () => {
    install.mockRejectedValue(new Error('Disk is full.'))
    status(base)
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Install' })
    fireEvent.click(button)
    expect(install).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('alert')).textContent).toBe('Disk is full.')
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('draws separators as decorative dots that screen readers skip', () => {
    for (const state of [
      { ...base, installedVersion: '1.5.0', installedCurrent: true },
      failedInstall
    ]) {
      const line = status(state)
      const dotted = parts(line).filter((part) => part.className.includes('before:content-'))
      expect(dotted.length).toBeGreaterThan(0)
      for (const part of dotted) {
        expect(part.className).toContain("before:content-['·'_/_'']")
      }
      expect(line.textContent).not.toContain('·')
      cleanup()
    }
  })
})
