// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import SkillsPage from './SkillsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

function skill(name: string): DiscoveredSkill {
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
    fileCount: 1,
    updatedAt: null
  }
}

function discoveryResult(names: string[]): SkillDiscoveryResult {
  return { skills: names.map(skill), sources: [], scannedAt: 1 }
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

/** Skill names currently rendered as cards. */
function renderedSkillNames(): string[] {
  return [...(container?.querySelectorAll('h3') ?? [])].map((node) => node.textContent ?? '')
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
      value: { skills: { discover }, runtimeEnvironments: { call } }
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
      value: { skills: { discover }, runtimeEnvironments: { call } }
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
      value: { skills: { discover }, runtimeEnvironments: { call } }
    })
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: false })

    await renderPage()
    await flushMicrotasks()

    expect(discover).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('Scanning skills')
  })
})
