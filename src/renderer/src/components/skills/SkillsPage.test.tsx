// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import SkillsPage from './SkillsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

function skill(name: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: `skill-${name}`,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: `/home/dev/.agents/skills`,
    directoryPath: `/home/dev/.agents/skills/${name}`,
    skillFilePath: `/home/dev/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

function discoveryResult(names: string[]): SkillDiscoveryResult {
  return { skills: names.map((name) => skill(name)), sources: [], scannedAt: 1 }
}

function skillsApi(discover: ReturnType<typeof vi.fn>) {
  return { discover, onInstallProgress: () => () => undefined }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function setRuntimeOwner(environmentId: string | null): void {
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: environmentId } as GlobalSettings,
    runtimeEnvironments: (environmentId ? [{ id: environmentId }] : []) as never,
    runtimeEnvironmentCatalogSettled: true
  })
}

async function renderPage(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <SkillsPage />
      </TooltipProvider>
    )
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })
}

/** Skill names currently rendered as rows. */
function renderedSkillNames(): string[] {
  return [...(container?.querySelectorAll('[data-skill-name]') ?? [])].map(
    (node) => node.textContent ?? ''
  )
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${name}`)
  }
  return button
}

function buttonStartingWith(prefix: string): HTMLButtonElement {
  const button = [...(container?.querySelectorAll('button') ?? [])].find((candidate) =>
    candidate.textContent?.trim().startsWith(prefix)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button starting with: ${prefix}`)
  }
  return button
}

function skillRow(name: string): HTMLElement {
  const row = [...(container?.querySelectorAll('[role="option"]') ?? [])].find(
    (candidate) => candidate.querySelector('[data-skill-name]')?.textContent === name
  )
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Missing skill row: ${name}`)
  }
  return row
}

function selectionCheckbox(name: string): HTMLButtonElement {
  const checkbox = container?.querySelector(`[aria-label="Select ${name}"]`)
  if (!(checkbox instanceof HTMLButtonElement)) {
    throw new Error(`Missing selection checkbox: ${name}`)
  }
  return checkbox
}

beforeEach(() => {
  setRuntimeOwner(null)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogSettled: false
  })
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillsPage', () => {
  it('uses platform-neutral Escape navigation without stealing editable input Escape', async () => {
    const closeSkillsPage = vi.fn()
    const discover = vi.fn().mockResolvedValue(discoveryResult(['alpha']))
    useAppStore.setState({ closeSkillsPage })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })
    await renderPage()
    await flushMicrotasks()

    const search = container?.querySelector('input[placeholder="Search skills"]')
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('Missing skill search')
    }
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeSkillsPage).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeSkillsPage).toHaveBeenCalledOnce()
  })

  it('contains long cross-platform skill paths while preserving the full path', async () => {
    const longPath = `C:\\Users\\orca\\${'nested-folder\\'.repeat(30)}SKILL.md`
    const discover = vi.fn().mockResolvedValue({
      skills: [skill('long-path', { skillFilePath: longPath })],
      sources: [],
      scannedAt: 1
    } satisfies SkillDiscoveryResult)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    // Why: the path lives in the detail dialog, where it must wrap inside the
    // column instead of pushing the dialog into horizontal scroll.
    await act(async () => fireEvent.click(skillRow('long-path')))

    const dialog = document.querySelector('[role="dialog"]')
    const path = [...(dialog?.querySelectorAll('*') ?? [])].find(
      (element) => element.textContent === longPath && element.children.length === 0
    )
    expect(path?.classList.contains('break-all')).toBe(true)
    expect(path?.textContent).toBe(longPath)
  })

  it('scans the connected remote runtime instead of the client disk', async () => {
    const discover = vi.fn().mockResolvedValue(discoveryResult(['local-only']))
    const call = vi.fn(
      async (args: { method: string; selector?: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'skills',
          ok: true,
          result: discoveryResult(['remote-only'])
        }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call } }
    })
    setRuntimeOwner('env-1')

    await renderPage()
    await flushMicrotasks()

    expect(discover).not.toHaveBeenCalled()
    expect(renderedSkillNames()).toContain('remote-only')
  })

  // Why: a cold local scan walks every skill root, so it can land after a newer
  // remote scan. Without a generation guard it overwrites the remote list and
  // the page silently shows the client's skills again — #6789 all over.
  it('does not let a slow local scan overwrite a newer remote scan', async () => {
    const localScan = deferred<SkillDiscoveryResult>()
    const discover = vi.fn().mockReturnValue(localScan.promise)
    const call = vi.fn(
      async (args: { method: string; selector?: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'skills',
          ok: true,
          result: discoveryResult(['remote-only'])
        }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call } }
    })

    await renderPage()
    await act(async () => {
      setRuntimeOwner('env-1')
    })
    await flushMicrotasks()
    expect(renderedSkillNames()).toContain('remote-only')

    localScan.resolve(discoveryResult(['local-only']))
    await flushMicrotasks()

    expect(renderedSkillNames()).toContain('remote-only')
    expect(renderedSkillNames()).not.toContain('local-only')
  })

  it('keeps scanning rather than listing client skills before the owner is known', async () => {
    const discover = vi.fn().mockResolvedValue(discoveryResult(['local-only']))
    const call = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call } }
    })
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: false })

    await renderPage()
    await flushMicrotasks()

    expect(discover).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('Scanning skills')
  })

  it('preserves hidden selections when selecting all filtered results', async () => {
    const discover = vi.fn().mockResolvedValue(discoveryResult(['alpha', 'beta']))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))
    await act(async () => fireEvent.click(selectionCheckbox('alpha')))

    const search = container?.querySelector('input[placeholder="Search skills"]')
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('Missing skill search')
    }
    await act(async () => fireEvent.input(search, { target: { value: 'beta' } }))
    expect(container?.textContent).toContain('1 selected')

    await act(async () => fireEvent.click(buttonStartingWith('Select all')))
    expect(container?.textContent).toContain('2 selected')
    await act(async () => fireEvent.input(search, { target: { value: '' } }))
    expect(selectionCheckbox('alpha').getAttribute('data-state')).toBe('checked')
    expect(selectionCheckbox('beta').getAttribute('data-state')).toBe('checked')
  })

  it('shows why skills are disabled and selects only one duplicate name', async () => {
    const discover = vi.fn().mockResolvedValue({
      skills: [
        skill('same-name', { id: 'home:same-name' }),
        skill('same-name', { id: 'repo:same-name', sourceKind: 'repo' }),
        skill('bundled-skill', { sourceKind: 'bundled' })
      ],
      sources: [],
      scannedAt: 1
    } satisfies SkillDiscoveryResult)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))
    expect(container?.textContent).toContain('Only home and workspace skills can be shared.')

    await act(async () => fireEvent.click(buttonStartingWith('Select all')))
    expect(container?.textContent).toContain('1 selected')
    expect(container?.textContent).toContain(
      'A skill with this name is already selected from another source.'
    )
  })

  // Why: Escape used to leave the page outright, discarding a selection that can
  // hold dozens of skills chosen one by one.
  it('backs out of share selection on Escape before leaving the page', async () => {
    const closeSkillsPage = vi.fn()
    const discover = vi.fn().mockResolvedValue(discoveryResult(['alpha']))
    useAppStore.setState({ closeSkillsPage })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))
    expect(container?.querySelector('[aria-label="Select alpha"]')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeSkillsPage).not.toHaveBeenCalled()
    expect(container?.querySelector('[aria-label="Select alpha"]')).toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeSkillsPage).toHaveBeenCalledOnce()
  })

  // Why: bundles run to ~30 skills; ticking each box one at a time is the flow
  // this page exists for.
  it('extends the share selection to a shift-clicked row', async () => {
    const discover = vi.fn().mockResolvedValue(discoveryResult(['alpha', 'beta', 'gamma']))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))
    await act(async () => fireEvent.click(skillRow('alpha')))
    expect(container?.textContent).toContain('1 selected')

    const gamma = skillRow('gamma')
    await act(async () => {
      fireEvent.pointerDown(gamma, { shiftKey: true })
      fireEvent.click(gamma, { shiftKey: true })
    })
    expect(container?.textContent).toContain('3 selected')
  })

  it('filters by source from the count chips', async () => {
    const discover = vi.fn().mockResolvedValue({
      skills: [skill('home-skill'), skill('plugin-skill', { sourceKind: 'plugin' })],
      sources: [],
      scannedAt: 1
    } satisfies SkillDiscoveryResult)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonStartingWith('Plugin')))

    expect(renderedSkillNames()).toEqual(['plugin-skill'])
    expect(container?.textContent).toContain('1 result')
  })

  // Why: the reason is per-row state, but on a remote runtime it applies to every
  // row at once — 114 copies of the same sentence is not an explanation.
  it('explains remote-only skills once instead of on every row', async () => {
    const call = vi.fn(
      async (args: { method: string; selector?: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'skills',
          ok: true,
          result: discoveryResult(['remote-one', 'remote-two'])
        }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(vi.fn()), runtimeEnvironments: { call } }
    })
    setRuntimeOwner('env-1')

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))

    const notices = (container?.textContent ?? '').split('Open Skills on that machine').length - 1
    expect(notices).toBe(1)
    expect(container?.textContent).not.toContain('Open this skill on its owning machine')
  })

  it('drops stale selections when a refreshed scan no longer contains the skill', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce(discoveryResult(['alpha', 'beta']))
      .mockResolvedValueOnce(discoveryResult(['beta']))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call: vi.fn() } }
    })

    await renderPage()
    await flushMicrotasks()
    await act(async () => fireEvent.click(buttonNamed('Share skills')))
    await act(async () => fireEvent.click(selectionCheckbox('alpha')))
    expect(container?.textContent).toContain('1 selected')

    await act(async () => fireEvent.click(buttonNamed('Refresh')))
    await flushMicrotasks()
    expect(container?.textContent).toContain('0 selected')
    expect(renderedSkillNames()).toEqual(['beta'])
  })
})
