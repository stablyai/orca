// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DebugAdapterDescription } from '../../../../preload/api/debug-api'
import type { DebugClient } from '@/lib/debug/debug-client'

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<{
      repos: { id: string; path: string; displayName: string }[]
      settingsSearchQuery: string
    }>(() => ({ repos: [], settingsSearchQuery: '' }))
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))
vi.mock('@/store', () => ({ useAppStore: mocks.store }))
vi.mock('@/lib/debug/debug-client', () => ({ debugClient: { describeAdapters: vi.fn() } }))

const { DebuggersSettingsSection } = await import('./DebuggersSettingsSection')

const DEBUGPY_KEY = JSON.stringify(['debugpy', '/usr/bin/python3', '-m', 'debugpy.adapter'])
const DEBUGPY: DebugAdapterDescription = {
  adapterId: 'debugpy',
  label: 'Python',
  languages: ['python'],
  transport: 'stdio',
  binaryPath: '/usr/bin/python3',
  args: ['-m', 'debugpy.adapter'],
  approvalKey: DEBUGPY_KEY,
  repoLocal: false,
  hint: null
}
const DLV: DebugAdapterDescription = {
  adapterId: 'dlv',
  label: 'Go',
  languages: ['go'],
  transport: 'socket',
  binaryPath: null,
  args: null,
  approvalKey: null,
  repoLocal: false,
  hint: 'Install Delve: go install github.com/go-delve/delve/cmd/dlv@latest'
}

const roots: ReturnType<typeof createRoot>[] = []
let updateSettings: ReturnType<typeof vi.fn<(updates: Partial<GlobalSettings>) => void>>
let describeAdapters: ReturnType<typeof vi.fn<DebugClient['describeAdapters']>>

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only the debug fields set here.
  return {
    debugEnabledRepos: [],
    debugAdapterApprovals: {},
    debugLaunchApprovals: {},
    debugPythonPath: '',
    debugJsDebugServerPath: '',
    ...overrides
  } as GlobalSettings
}

async function render(settings: GlobalSettings): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <DebuggersSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        client={{ describeAdapters }}
      />
    )
  })
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (element) => element.getAttribute('aria-label') === label || element.textContent === label
  )
  if (!match) {
    throw new Error(`no button ${label}`)
  }
  return match
}

beforeEach(() => {
  updateSettings = vi.fn()
  describeAdapters = vi
    .fn<DebugClient['describeAdapters']>()
    .mockResolvedValue({ ok: true, value: [DEBUGPY, DLV] })
  mocks.store.setState({
    repos: [{ id: 'repo-1', path: '/work/app', displayName: 'App' }],
    settingsSearchQuery: ''
  })
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('DebuggersSettingsSection', () => {
  it('writes debugEnabledRepos when debugging is allowed and disallowed', async () => {
    const off = await render(settingsWith({ debugEnabledRepos: ['other'] }))
    await act(async () => button(off, 'Allow debugging App').click())
    expect(updateSettings).toHaveBeenLastCalledWith({ debugEnabledRepos: ['other', 'repo-1'] })
    expect(describeAdapters).not.toHaveBeenCalled()

    const on = await render(settingsWith({ debugEnabledRepos: ['other', 'repo-1'] }))
    await act(async () => button(on, 'Allow debugging App').click())
    expect(updateSettings).toHaveBeenLastCalledWith({ debugEnabledRepos: ['other'] })
  })

  it("keeps each project's row when the search names the section", async () => {
    mocks.store.setState({ settingsSearchQuery: 'Debuggers' })
    const container = await render(settingsWith({}))
    expect(button(container, 'Allow debugging App')).toBeTruthy()
  })

  it('lists adapters with the exact binary and args, and the install hint when missing', async () => {
    const container = await render(settingsWith({ debugEnabledRepos: ['repo-1'] }))
    expect(describeAdapters).toHaveBeenCalledWith({ repoId: 'repo-1', worktreePath: '/work/app' })
    expect(container.textContent).toContain('/usr/bin/python3 -m debugpy.adapter')
    expect(container.textContent).toContain(DLV.hint)
    expect(() => button(container, 'Approve Go')).toThrow()
  })

  it('approves and revokes the exact approvalKey for this repo', async () => {
    const approvals = { other: ['x'] }
    const off = await render(
      settingsWith({ debugEnabledRepos: ['repo-1'], debugAdapterApprovals: approvals })
    )
    await act(async () => button(off, 'Approve Python').click())
    expect(updateSettings).toHaveBeenLastCalledWith({
      debugAdapterApprovals: { other: ['x'], 'repo-1': [DEBUGPY_KEY] }
    })

    const on = await render(
      settingsWith({
        debugEnabledRepos: ['repo-1'],
        debugAdapterApprovals: { ...approvals, 'repo-1': [DEBUGPY_KEY, 'kept'] }
      })
    )
    await act(async () => button(on, 'Revoke Python').click())
    expect(updateSettings).toHaveBeenLastCalledWith({
      debugAdapterApprovals: { other: ['x'], 'repo-1': ['kept'] }
    })
  })

  it('warns when the adapter binary lives inside the repository', async () => {
    describeAdapters.mockResolvedValue({ ok: true, value: [{ ...DEBUGPY, repoLocal: true }] })
    const container = await render(settingsWith({ debugEnabledRepos: ['repo-1'] }))
    expect(container.textContent).toContain('This binary is inside App')
  })

  it('shows a refusal instead of adapters for a repo core will not debug', async () => {
    describeAdapters.mockResolvedValue({
      ok: false,
      reason: 'remote-workspace',
      message: 'Debugging runs only on this machine.'
    })
    const container = await render(settingsWith({ debugEnabledRepos: ['repo-1'] }))
    expect(container.textContent).toContain('Debugging runs only on this machine.')
  })

  it('shows a rejected adapter lookup as an error instead of looking forever', async () => {
    describeAdapters.mockRejectedValue(new Error('bridge gone'))
    const container = await render(settingsWith({ debugEnabledRepos: ['repo-1'] }))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('bridge gone')
    expect(container.textContent).not.toContain('Looking for installed debug adapters')
  })

  it('says so when no debug adapter is found', async () => {
    describeAdapters.mockResolvedValue({ ok: true, value: [] })
    const container = await render(settingsWith({ debugEnabledRepos: ['repo-1'] }))
    expect(container.textContent).toContain('No debug adapters found for this project.')
  })

  it('lists approved launch hashes and revokes one', async () => {
    const container = await render(
      settingsWith({ debugLaunchApprovals: { 'repo-1': ['hash-a', 'hash-b'], other: ['h'] } })
    )
    expect(container.textContent).toContain('hash-a')
    await act(async () => button(container, 'Revoke hash-a').click())
    expect(updateSettings).toHaveBeenLastCalledWith({
      debugLaunchApprovals: { other: ['h'], 'repo-1': ['hash-b'] }
    })
  })

  it.each([
    ['Python for debugpy', 'debugPythonPath', '/opt/py/bin/python'],
    ['js-debug Server', 'debugJsDebugServerPath', '/opt/js-debug/src/dapDebugServer.js']
  ] as const)('commits %s on blur', async (label, field, value) => {
    const container = await render(settingsWith({}))
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!input) {
      throw new Error(`no input ${label}`)
    }
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, `  ${value}  `)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.focus()
      input.blur()
    })
    expect(updateSettings).toHaveBeenLastCalledWith({ [field]: value })
  })
})
