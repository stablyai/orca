// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory
} from '../../../../shared/skill-freshness'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

const mocks = vi.hoisted(() => ({
  inventory: null as SkillFreshnessInventory | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  terminalProps: [] as {
    command: string
    description: string
    onInteracted?: (method: 'keyboard' | 'pointer', event?: { key?: string }) => void
    onTerminalExit?: () => void
  }[],
  notifyChanged: vi.fn()
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: mocks.loading,
    error: mocks.error,
    refresh: mocks.refresh
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: (typeof mocks.terminalProps)[number]) => {
    mocks.terminalProps.push(props)
    return <div data-testid="update-terminal">{props.command}</div>
  }
}))

// Radix Dialog/Collapsible internals (portal, focus-scope) are exercised in
// Electron QA; here the content logic is what matters, so use plain wrappers.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-dialog-open="true">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({
    children,
    defaultOpen = false
  }: {
    children?: ReactNode
    defaultOpen?: boolean
  }) => {
    // Model Radix's uncontrolled default: changing defaultOpen only matters
    // when the keyed disclosure remounts.
    const [open] = useState(defaultOpen)
    return <div data-collapsible-open={String(open)}>{children}</div>
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

function placement(
  name: string,
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: `${name}-${overrides.rootId ?? 'home-agents'}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology: 'canonical-copy',
    status: 'outdated',
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: 'old',
    errorCategory: null,
    ...overrides
  }
}

function eligibleInventory(): SkillFreshnessInventory {
  return {
    schemaVersion: 1,
    installations: [placement('orca-cli')],
    eligibleUpdateNames: ['orca-cli'],
    scannedAt: 1
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderDialog(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessUpdateDialog />)
  })
}

async function rerender(): Promise<void> {
  await act(async () => {
    root?.render(<SkillFreshnessUpdateDialog />)
  })
}

async function openViaRequest(): Promise<void> {
  await act(async () => {
    requestSkillFreshnessUpdateDialog()
  })
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('SkillFreshnessUpdateDialog', () => {
  beforeEach(() => {
    consumeSkillFreshnessUpdateDialogRequest()
    mocks.inventory = eligibleInventory()
    mocks.loading = false
    mocks.error = null
    mocks.refresh.mockReset()
    mocks.notifyChanged.mockReset()
    mocks.terminalProps.length = 0
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('stays closed until an open request arrives', async () => {
    await renderDialog()
    expect(container?.querySelector('[data-dialog-open]')).toBeNull()
  })

  it('shows the eligible summary and the exact pre-filled draft command', async () => {
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('Update skills')
    expect(container?.textContent).toContain('1 skill can be updated safely')
    expect(mocks.terminalProps.at(-1)).toMatchObject({
      command: 'npx skills update orca-cli --global',
      description: 'Review the pre-filled command, then press Enter to run it.'
    })
  })

  it('resolves a request made before inventory loads once a safe command arrives', async () => {
    mocks.inventory = null
    await openViaRequest()
    await renderDialog()

    expect(container?.querySelector('[data-dialog-open]')).not.toBeNull()
    expect(mocks.terminalProps).toEqual([])

    mocks.inventory = eligibleInventory()
    await rerender()

    expect(mocks.terminalProps.at(-1)?.command).toBe('npx skills update orca-cli --global')
  })

  it('shows the up-to-date state once every installation is current', async () => {
    await renderDialog()
    await openViaRequest()

    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli', { status: 'current', observedPackageDigest: 'current' })
      ],
      eligibleUpdateNames: [],
      scannedAt: 2
    }
    await rerender()

    expect(container?.textContent).toContain('All installed Orca skills are up to date.')
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()
  })

  it('auto-expands Details when a rescan changes the result to blocked', async () => {
    await renderDialog()
    await openViaRequest()
    expect(container?.querySelector('[data-collapsible-open="false"]')).not.toBeNull()

    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orca-cli', { topology: 'read-only' })],
      eligibleUpdateNames: [],
      scannedAt: 2
    }
    await rerender()

    expect(container?.querySelector('[data-collapsible-open="true"]')).not.toBeNull()
  })

  it('does not replace or tear down a submitted command during a rescan', async () => {
    await renderDialog()
    await openViaRequest()

    await act(async () => {
      mocks.terminalProps.at(-1)?.onInteracted?.('keyboard', { key: 'Enter' })
    })
    mocks.inventory = null
    mocks.loading = true
    await rerender()

    expect(container?.querySelector('[data-testid="update-terminal"]')?.textContent).toBe(
      'npx skills update orca-cli --global'
    )

    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli', { status: 'current', observedPackageDigest: 'current' })
      ],
      eligibleUpdateNames: [],
      scannedAt: 2
    }
    mocks.loading = false
    await rerender()

    expect(container?.textContent).toContain('All installed Orca skills are up to date.')
    expect(container?.querySelector('[data-testid="update-terminal"]')?.textContent).toBe(
      'npx skills update orca-cli --global'
    )
  })

  it('removes an unsubmitted draft as soon as its inventory is invalidated', async () => {
    await renderDialog()
    await openViaRequest()
    expect(container?.querySelector('[data-testid="update-terminal"]')).not.toBeNull()

    mocks.inventory = null
    mocks.loading = true
    await rerender()

    expect(container?.textContent).toContain('Checking installed Orca skills')
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()
  })

  it('shows a failed scan as an error instead of indefinite progress', async () => {
    mocks.inventory = null
    mocks.error = 'Could not inspect installed skills.'
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('Could not inspect installed skills.')
    expect(container?.textContent).not.toContain('Checking installed Orca skills')
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()
  })

  it('creates a fresh draft after a terminal exits and the rescan still finds an update', async () => {
    await renderDialog()
    await openViaRequest()
    const firstTerminal = mocks.terminalProps.at(-1)

    await act(async () => {
      firstTerminal?.onTerminalExit?.()
    })
    expect(mocks.notifyChanged).toHaveBeenCalledTimes(1)
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()

    mocks.inventory = { ...eligibleInventory(), scannedAt: 2 }
    await rerender()

    expect(container?.querySelector('[data-testid="update-terminal"]')?.textContent).toBe(
      'npx skills update orca-cli --global'
    )
    expect(mocks.terminalProps.at(-1)).not.toBe(firstTerminal)
  })

  it('explains a poisoned sibling in Details without offering a command', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli'),
        placement('orca-cli', {
          id: 'repo-copy',
          rootId: 'repo',
          sourceKind: 'repo',
          topology: 'repo-scope',
          status: 'unrecognized',
          unresolvedPath: '/repo/.agents/skills/orca-cli'
        })
      ],
      eligibleUpdateNames: [],
      scannedAt: 1
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain(
      'it may be modified, or a different skill with the same name'
    )
    expect(container?.textContent).toContain('Unrecognized')
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()
  })

  it('explains a self-blocked read-only placement without blaming a sibling', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orca-cli', { topology: 'read-only' })],
      eligibleUpdateNames: [],
      scannedAt: 1
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain(
      'read-only location, so Orca left it out of the update'
    )
    expect(container?.textContent).toContain('Read only')
  })

  it('re-inventories installed skills when the dialog closes', async () => {
    await renderDialog()
    await openViaRequest()

    await clickButton('Close')

    expect(mocks.notifyChanged).toHaveBeenCalledTimes(1)
    expect(container?.querySelector('[data-dialog-open]')).toBeNull()
  })

  it('forces a re-check from the Re-check affordance', async () => {
    await renderDialog()
    await openViaRequest()

    await clickButton('Re-check')

    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
