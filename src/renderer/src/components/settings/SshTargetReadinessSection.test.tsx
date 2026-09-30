// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshReadinessCheck, SshReadinessReport } from '../../../../shared/ssh-types'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }))

import { i18n } from '../../i18n/i18n'
import { SshTargetReadinessSection } from './SshTargetReadinessSection'

type Api = {
  probeReadiness: ReturnType<typeof vi.fn>
  writeClipboardText: ReturnType<typeof vi.fn>
}

function check(
  key: SshReadinessCheck['key'],
  state: SshReadinessCheck['state'],
  detail: string
): SshReadinessCheck {
  return { key, state, detail }
}

function stubApi(probe: () => Promise<SshReadinessReport>): Api {
  const probeReadiness = vi.fn(probe)
  const writeClipboardText = vi.fn(() => Promise.resolve())
  Object.defineProperty(globalThis, 'api', {
    configurable: true,
    value: { ssh: { probeReadiness }, ui: { writeClipboardText } }
  })
  return { probeReadiness, writeClipboardText }
}

function buttonIn(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  expect(found).not.toBeUndefined()
  return found!
}

function rowFor(container: HTMLElement, label: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('li')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  expect(found).not.toBeUndefined()
  return found!
}

async function renderChecked(
  probe: () => Promise<SshReadinessReport>
): Promise<{ container: HTMLElement } & Api> {
  const api = stubApi(probe)
  const { container } = render(<SshTargetReadinessSection targetId="target-1" />)
  fireEvent.click(buttonIn(container, 'Check'))
  return { container, ...api }
}

const rows = (container: HTMLElement): number => container.querySelectorAll('li').length
const copyButtons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('button')).filter((candidate) =>
    candidate.textContent?.includes('Copy login command')
  )

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'api')
  toastSuccess.mockClear()
})

describe('SshTargetReadinessSection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders one row per check once the probe answers', async () => {
    const { container, probeReadiness } = await renderChecked(() =>
      Promise.resolve({
        checks: [check('node', 'ok', 'node 22.11.0'), check('toolchain', 'miss', 'pnpm not found')],
        probedAt: 1
      })
    )

    await waitFor(() => expect(rows(container)).toBe(2))
    expect(probeReadiness).toHaveBeenCalledWith({ targetId: 'target-1' })
    expect(container.textContent).toContain('Node')
    expect(container.textContent).toContain('node 22.11.0')
    expect(container.textContent).toContain('Toolchain')
    expect(container.textContent).toContain('pnpm not found')
  })

  it('offers a login command only for a missing check the host must sign in for itself', async () => {
    const { container } = await renderChecked(() =>
      Promise.resolve({
        checks: [
          check('claude', 'miss', 'claude CLI not found'),
          check('codex', 'ok', 'codex-cli 0.9.1'),
          check('gh-auth', 'miss', 'gh is not signed in'),
          check('node', 'miss', 'node not found')
        ],
        probedAt: 1
      })
    )

    await waitFor(() => expect(rows(container)).toBe(4))
    expect(copyButtons(container)).toHaveLength(2)
    expect(rowFor(container, 'Claude').querySelectorAll('button')).toHaveLength(1)
    expect(rowFor(container, 'GitHub CLI auth').querySelectorAll('button')).toHaveLength(1)
    expect(rowFor(container, 'Codex').querySelectorAll('button')).toHaveLength(0)
    // A missing Node is Orca's to install, not something the user logs into.
    expect(rowFor(container, 'Node').querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).toContain(
      'Run it in a terminal on this host; the sign-in page opens here.'
    )
  })

  it('copies the command that signs the host in', async () => {
    const { container, writeClipboardText } = await renderChecked(() =>
      Promise.resolve({
        checks: [check('gh-auth', 'miss', 'gh is not signed in')],
        probedAt: 1
      })
    )

    await waitFor(() => expect(copyButtons(container)).toHaveLength(1))
    fireEvent.click(buttonIn(container, 'Copy login command'))

    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith('gh auth login --web --git-protocol https')
    )
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('shows the probe failure instead of rows', async () => {
    const { container } = await renderChecked(() => Promise.reject(new Error('relay offline')))

    await waitFor(() => expect(container.textContent).toContain('relay offline'))
    expect(rows(container)).toBe(0)
  })
})
