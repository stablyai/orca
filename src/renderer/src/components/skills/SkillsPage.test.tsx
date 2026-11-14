// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useAppStore } from '@/store/index'
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
})
