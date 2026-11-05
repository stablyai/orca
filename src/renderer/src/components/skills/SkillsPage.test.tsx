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
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
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
  return {
    discover,
    deleteSupported: () => Promise.resolve(true),
    onInstallProgress: () => () => undefined
  }
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
        <ConfirmationDialogProvider>
          <SkillsPage />
        </ConfirmationDialogProvider>
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
  // A slow cold local scan must not overwrite a newer remote scan after target switching.
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

  it("does not show one runtime's skills when the next runtime scan fails", async () => {
    const discover = vi.fn().mockResolvedValue(discoveryResult(['local-only']))
    const call = vi.fn(async (args: { method: string; selector?: string }) => {
      const compatibilityResponse = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatibilityResponse) {
        return compatibilityResponse
      }
      throw new Error('remote unavailable')
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: skillsApi(discover), runtimeEnvironments: { call } }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderPage()
    await flushMicrotasks()
    expect(renderedSkillNames()).toEqual(['local-only'])

    await act(async () => {
      setRuntimeOwner('env-1')
    })
    await flushMicrotasks()

    expect(container?.textContent).toContain('Could not scan skills')
    expect(renderedSkillNames()).toEqual([])
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
