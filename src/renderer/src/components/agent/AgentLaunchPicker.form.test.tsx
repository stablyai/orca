// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  sourceControlPickerDraft,
  applySourceControlPickerDraft
} from '../settings/source-control-agent-launch-picker'
import { canonicalSourceControlActionSelection } from '../../../../shared/source-control-action-selection'
import { AgentLaunchSetupButton, useAgentPickerDraftScope } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  useAgentPickerSetup,
  invalidateAgentPickerDrafts,
  retireAgentPickerDrafts
} from './agent-launch-picker-drafts'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { useNewTabAgentMenuRows } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async (_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog' ? entry.catalog : { seedOptions: {} }
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
let owner = 0
const launch = vi.fn()
function show(value: AgentPickerEntry, others: AgentPickerEntry[] = []) {
  const entries = [value, ...others]
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu
              entries={entries}
              model={{
                state: 'settled',
                rows: entries.flatMap((entry) => entry.rows),
                detection: {
                  detectedIds: entries.map((entry) => entry.agent),
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => entries.map((entry) => entry.agent)
                }
              }}
              runLaunch={launch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
}
beforeEach(() => {
  entry.ownerKey = `menu-test-${owner++}`
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  show(entry)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['button', 'enter'] as const)(
  'reopens a form selection and preserves its route on %s',
  (activation) => {
    const initial = {
      agent: 'codex' as const,
      surface: 'terminal' as const,
      choices: { model: 'astra', options: { effort: 'low' } }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={entry} initial={initial} mode="select" onUse={launch} />
        </TooltipProvider>
      )
    )
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
    )
    expect(launch).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Open terminal')
    if (activation === 'enter') {
      fireEvent.keyDown(document.querySelector('input[aria-label="Search models"]')!, {
        key: 'Enter'
      })
    } else {
      fireEvent.click(
        [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
      )
    }
    expect(launch).toHaveBeenCalledExactlyOnceWith(initial)
  }
)

it('rebases accepted recipe receipts and retires independent form scopes with equal baselines', () => {
  const inventory = { ...entry, defaultSurface: 'terminal' as const, arguments: '--base' }
  function Form({ request }: { request: string }) {
    const scope = useAgentPickerDraftScope(request)
    const [selection, update] = useState(() =>
      canonicalSourceControlActionSelection({ agentId: 'codex' })
    )
    return (
      <AgentLaunchSetupButton
        entry={inventory}
        draftScope={scope}
        initial={sourceControlPickerDraft(selection, inventory, 'terminal')}
        mode="select"
        onUse={(draft) => {
          launch(draft)
          update((current) => applySourceControlPickerDraft(current, inventory, draft))
        }}
      />
    )
  }
  const showForm = (request: string) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <Form request={request} />
        </TooltipProvider>
      )
    )
  const open = () =>
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
    )
  showForm('first')
  open()
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--accepted' } })
  fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use')!)
  expect(launch.mock.calls.at(-1)?.[0].recipeEdits.changed).toBe(true)
  open()
  expect(document.querySelector('textarea')).toHaveProperty('value', '--accepted')
  fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use')!)
  expect(launch.mock.calls.at(-1)?.[0].recipeEdits.changed).toBe(false)
  open()
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--unaccepted' } })
  showForm('second')
  expect(document.querySelector('textarea')).toHaveProperty('value', '--accepted')
  act(() =>
    root.render(
      <TooltipProvider>
        <Form key="new-controller" request="second" />
      </TooltipProvider>
    )
  )
  open()
  expect(document.querySelector('textarea')).toHaveProperty('value', '--base')
})

it.each([3, 30])(
  'retires unreachable catalog setups across %s committed generations without losing current/opaque drafts',
  async (generations) => {
    let scope: object
    let readScope: (() => unknown) | undefined
    let snapshots: Map<unknown, unknown> | undefined
    const originalGet = WeakMap.prototype.get
    WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
      const result = originalGet.call(this, key)
      if (key === scope) {
        readScope = () => originalGet.call(this, scope!)
        if (result instanceof Map) {
          snapshots = result
        }
      }
      return result
    }
    try {
      const live = {
        id: 'live',
        label: 'Live',
        isDefault: true,
        efforts: [{ value: 'high', label: 'High' }]
      }
      let catalogEntry: AgentPickerEntry = entry
      function Form({ inventory }: { inventory: AgentPickerEntry }) {
        scope = useAgentPickerDraftScope()
        return <AgentLaunchPickerMenu draftScope={scope} entries={[inventory]} runLaunch={launch} />
      }
      const membershipReads = { models: 0, efforts: 0 }
      const showGeneration = (
        generation: number,
        known = true,
        authority = 'same-authority',
        phase?: 'listing' | 'count'
      ) => {
        catalogEntry = {
          ...entry,
          ownerKey: `${entry.ownerKey}/${authority}`,
          defaultSurface: 'terminal',
          catalog: known
            ? {
                origin: 'probe',
                fetchedAt: generation,
                listingInProgress: phase === 'listing',
                models: [
                  live,
                  {
                    id: `retired-g${generation}`,
                    label: `Retired g${generation}`,
                    isDefault: false,
                    efforts: [{ value: 'high', label: 'High' }]
                  }
                ]
              }
            : { origin: 'unknown' }
        }
        if (phase === 'count' && catalogEntry.catalog.origin !== 'unknown') {
          for (const model of catalogEntry.catalog.models) {
            const id = model.id
            Object.defineProperty(model, 'id', {
              configurable: true,
              get() {
                membershipReads.models++
                return id
              }
            })
            for (const effort of model.efforts) {
              const value = effort.value
              Object.defineProperty(effort, 'value', {
                configurable: true,
                get() {
                  membershipReads.efforts++
                  return value
                }
              })
            }
          }
        }
        act(() =>
          root.render(
            <TooltipProvider>
              <DropdownMenu defaultOpen modal={false}>
                <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
                <DropdownMenuContent>
                  <Form inventory={catalogEntry} />
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          )
        )
      }
      const query = (text: string) =>
        fireEvent.change(
          document.querySelector('input[placeholder="Search agents and setups…"]')!,
          { target: { value: text } }
        )
      const open = (label: string) => {
        const row = [...document.querySelectorAll('[role="menuitem"]')].find((row) =>
          row.textContent?.includes(label)
        )!
        fireEvent.click(row.querySelector('button')!)
      }
      const close = () => fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
      showGeneration(0)
      query('Live high')
      open('Live · High')
      fireEvent.change(document.querySelector('textarea')!, { target: { value: '--pending-live' } })
      close()
      for (let generation = 1; generation <= generations; generation++) {
        showGeneration(generation, true, 'same-authority', 'listing')
        query(`Retired g${generation} high`)
        open(`Retired g${generation} · High`)
        fireEvent.change(document.querySelector('textarea')!, {
          target: { value: `--pending-retired-${generation}` }
        })
        close()
      }
      expect(snapshots!.size).toBe(generations + 1)
      query('no matching setup')
      showGeneration(generations, true, 'same-authority', 'count')
      expect(membershipReads.models).toBeLessThanOrEqual(20)
      expect(membershipReads.efforts).toBeLessThanOrEqual(8)
      expect(snapshots!.size).toBe(2)
      expect([...snapshots!.values()]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            draft: expect.objectContaining({
              pendingArguments: '--pending-live',
              choices: { model: 'live', options: { effort: 'high' } }
            })
          })
        ])
      )
      query('no matching setup')
      expect(snapshots!.size).toBe(2)
      query('Live high')
      open('Live · High')
      expect(document.querySelector('textarea')).toHaveProperty('value', '--pending-live')
      close()
      // Unknown acquisition is not evidence the previous identities died.
      showGeneration(generations, false)
      expect(snapshots!.size).toBe(2)
      showGeneration(generations)
      query('Live high')
      open('Live · High')
      expect(document.querySelector('textarea')).toHaveProperty('value', '--pending-live')
      close()
      // The ordinary agent setup remains a legitimate opaque/unlisted choice.
      query('Codex')
      open('Codex')
      fireEvent.change(document.querySelector('textarea')!, {
        target: { value: '--model private/unlisted --opaque' }
      })
      fireEvent.blur(document.querySelector('textarea')!)
      close()
      showGeneration(generations + 1)
      query('Codex')
      open('Codex')
      expect(document.querySelector('textarea')).toHaveProperty('value', '--opaque')
      expect(document.body.textContent).toContain('private/unlisted')
      close()
      expect(snapshots!.size).toBe(2)
      // A genuine authority replacement retires old snapshots; a new draft belongs to its new owner.
      for (let generation = 1; generation <= generations; generation++) {
        showGeneration(generation, true, `authority-${generation}`)
        query('Live high')
        open('Live · High')
        fireEvent.change(document.querySelector('textarea')!, {
          target: { value: '--new-authority' }
        })
        close()
      }
      expect(snapshots!.size).toBe(1)
      expect(readScope!()).toBe(snapshots)
      act(() => root.render(<div />))
      await waitFor(() => expect(readScope!()).toBeUndefined())
    } finally {
      WeakMap.prototype.get = originalGet
    }
  }
)

it.each(['ordinary', 'search'] as const)(
  'keeps actual worktree + %s accepted/pending owners across W1/W2 and retires actual target death',
  async (kind) => {
    const previous = useAppStore.getState()
    const first = makeWorktree({ id: 'repo1::/w1', path: '/w1', hostId: 'local' })
    const second = makeWorktree({ id: 'repo1::/w2', path: '/w2', hostId: 'local' })
    useAppStore.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [first, second] },
      settings: {
        ...getDefaultSettings('/synthetic'),
        experimentalNativeChat: false,
        agentPermissionDefault: 'own'
      },
      localDetectedAgentIdsByContext: { host: ['codex'] },
      ensureDetectedAgents: async () => ['codex']
    })
    function Plus({ id }: { id: string }) {
      const menu = useNewTabAgentMenuRows(id, true, { kind: 'local', contextKey: 'host' })
      const entries = useAgentLaunchPickerInventory(id, menu, true)
      return <AgentLaunchPickerMenu entries={entries} runLaunch={launch} />
    }
    const visit = async (id: string) => {
      act(() => {
        useAppStore.setState({ activeWorktreeId: id })
        root.render(
          <TooltipProvider>
            <DropdownMenu defaultOpen modal={false}>
              <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
              <DropdownMenuContent>
                <Plus id={id} />
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        )
      })
      await waitFor(() =>
        expect(document.querySelector('button[aria-label="Configure Codex"]')).not.toBeNull()
      )
      if (kind === 'search') {
        fireEvent.change(
          document.querySelector('input[placeholder="Search agents and setups…"]')!,
          { target: { value: 'Astra low' } }
        )
        await waitFor(() =>
          expect(document.querySelector('[role="menuitem"]')?.textContent).toContain('Astra · Low')
        )
      }
      fireEvent.click(document.querySelector('[role="menuitem"] button')!)
      await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
    }
    const close = () => fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
    try {
      await visit(first.id)
      fireEvent.change(document.querySelector('textarea')!, {
        target: { value: '--model private/w1 --accepted-w1' }
      })
      fireEvent.blur(document.querySelector('textarea')!)
      fireEvent.change(document.querySelector('textarea')!, { target: { value: '--pending-w1' } })
      close()
      await visit(second.id)
      expect(document.querySelector('textarea')).not.toHaveProperty('value', '--pending-w1')
      fireEvent.change(document.querySelector('textarea')!, { target: { value: '--pending-w2' } })
      close()
      await visit(first.id)
      expect(document.querySelector('textarea')).toHaveProperty('value', '--pending-w1')
      expect(document.body.textContent).toContain('private/w1')
      close()
      // Definitive current store removal, not visiting another target or filtering.
      act(() => useAppStore.setState({ worktreesByRepo: { repo1: [second] } }))
      await visit(second.id)
      close()
      act(() => useAppStore.setState({ worktreesByRepo: { repo1: [first, second] } }))
      await visit(first.id)
      expect(document.querySelector('textarea')).not.toHaveProperty('value', '--pending-w1')
      expect(document.body.textContent).not.toContain('private/w1')
    } finally {
      act(() => {
        root.render(<div />)
        useAppStore.setState(previous, true)
      })
    }
  }
)

it.each([3, 30])(
  'retires inactive identities over %s actual acquisition generations while keeping the current full envelope',
  async (generations) => {
    const previous = useAppStore.getState()
    const worktree = makeWorktree({
      id: `repo1::/acquisition-${generations}`,
      path: '/acquisition',
      hostId: 'local'
    })
    const originalCatalog = entry.catalog
    useAppStore.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [worktree] },
      settings: {
        ...getDefaultSettings('/synthetic'),
        experimentalNativeChat: false,
        agentPermissionDefault: 'own'
      },
      localDetectedAgentIdsByContext: { host: ['codex'] },
      ensureDetectedAgents: async () => ['codex']
    })
    let generation = 0
    let scope: object
    let records: Map<unknown, unknown> | undefined
    let readScope: (() => unknown) | undefined
    const originalGet = WeakMap.prototype.get
    WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
      const result = originalGet.call(this, key)
      if (key === scope && result instanceof Map) {
        readScope = () => originalGet.call(this, scope!)
        records = result
      }
      return result
    }
    const setCatalog = () => {
      entry.catalog = {
        origin: 'probe',
        fetchedAt: generation,
        models: [
          {
            id: 'live',
            label: 'Live',
            isDefault: true,
            efforts: [
              { value: 'high', label: 'High' },
              { value: `phase${generation}`, label: `Phase${generation}` }
            ]
          },
          {
            id: `generation-${generation}`,
            label: `Generation ${generation}`,
            isDefault: false,
            efforts: [{ value: 'high', label: 'High' }]
          }
        ]
      }
    }
    setCatalog()
    function Owner({ open }: { open: boolean }) {
      scope = useAgentPickerDraftScope()
      const menu = useNewTabAgentMenuRows(worktree.id, open, { kind: 'local', contextKey: 'host' })
      const entries = useAgentLaunchPickerInventory(worktree.id, menu, open)
      return createElement(
        TooltipProvider,
        null,
        createElement(
          DropdownMenu,
          { open, modal: false },
          createElement(DropdownMenuTrigger, null, 'New tab'),
          createElement(
            DropdownMenuContent,
            null,
            createElement(AgentLaunchPickerMenu, {
              entries,
              draftScope: scope,
              runLaunch: () => {}
            })
          )
        )
      )
    }
    const view = render(createElement(Owner, { open: true }))
    const openSetup = async (text: string, effort = 'high') => {
      const search = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search agents and setups…"]'
      )!
      fireEvent.change(search, { target: { value: `${text} ${effort}` } })
      await vi.waitFor(() =>
        expect(
          [...document.querySelectorAll('[role="menuitem"]')].some((row) =>
            row.textContent?.includes(text)
          )
        ).toBe(true)
      )
      const row = [...document.querySelectorAll('[role="menuitem"]')].find((row) =>
        row.textContent?.includes(text)
      )!
      fireEvent.click(row.querySelector('button')!)
      if (!document.querySelector('textarea')) {
        fireEvent.click(document.querySelector('button[aria-label="Toggle Arguments"]')!)
      }
    }
    try {
      await act(async () => {})
      await openSetup('Live')
      fireEvent.change(document.querySelector('textarea')!, {
        target: { value: '--model private/opaque --accepted' }
      })
      fireEvent.blur(document.querySelector('textarea')!)
      fireEvent.change(document.querySelector('textarea')!, { target: { value: '--latest-live' } })
      // Filtering does not own the active envelope.
      fireEvent.change(document.querySelector('input[placeholder="Search agents and setups…"]')!, {
        target: { value: 'nothing matches' }
      })
      expect(document.querySelector('textarea')).toHaveProperty('value', '--latest-live')
      fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
      view.rerender(createElement(Owner, { open: false }))
      await act(async () => {})
      for (generation = 1; generation <= generations; generation++) {
        setCatalog()
        view.rerender(createElement(Owner, { open: true }))
        await act(async () => {})
        await openSetup(`Generation ${generation}`)
        fireEvent.change(document.querySelector('textarea')!, {
          target: { value: '--inactive-current' }
        })
        fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
        expect(records!.size).toBe(2)
        await openSetup('Live', `phase${generation}`)
        fireEvent.change(document.querySelector('textarea')!, {
          target: { value: '--inactive-effort' }
        })
        fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
        expect(records!.size).toBe(3)
        view.rerender(createElement(Owner, { open: false }))
        await act(async () => {})
      }
      view.rerender(createElement(Owner, { open: true }))
      await act(async () => {})
      await openSetup('Live')
      expect(document.querySelector('textarea')).toHaveProperty('value', '--latest-live')
      expect(document.body.textContent).toContain('private/opaque')
      view.unmount()
      expect(readScope!()).toBeUndefined()
    } finally {
      view.unmount()
      WeakMap.prototype.get = originalGet
      entry.catalog = originalCatalog
      useAppStore.setState(previous, true)
    }
  }
)

it('uses definitive inactive model/effort evidence only and fences retired owner callbacks', () => {
  // Controlled-boundary invariant, not a claimed mid-open acquisition catalog stream.
  const scope = {}
  const target = { key: 'boundary-target', executionHostId: 'local' }
  const source = { ...entry, ownerKey: 'boundary-authority', draftTarget: target }
  const initial = {
    agent: 'codex' as const,
    surface: 'terminal' as const,
    choices: { model: 'live', options: { effort: 'high' } }
  }
  const { result, rerender, unmount } = renderHook(
    ({
      current,
      open,
      initial
    }: {
      current: AgentPickerEntry
      open: boolean
      initial: AgentPickerDraft
    }) =>
      useAgentPickerSetup({
        entry: current,
        initial,
        draftScope: scope,
        draftId: 'live:high',
        preset: { model: 'live', effort: 'high' },
        open
      }),
    { initialProps: { current: source, initial, open: true } }
  )
  const accepted = {
    ...initial,
    choices: { model: 'private/opaque', options: { effort: 'high' } },
    pendingArguments: '--latest'
  }
  act(() => result.current.change(accepted))
  const active = result.current
  const catalog = (
    efforts: { value: string; label: string }[],
    effortsKnown = true,
    listingInProgress = false
  ): AgentPickerEntry => ({
    ...source,
    catalog: {
      origin: 'probe',
      fetchedAt: 2,
      listingInProgress,
      models: [{ id: 'live', label: 'Live', isDefault: true, efforts, effortsKnown }]
    }
  })
  act(() => retireAgentPickerDrafts([catalog([])], scope))
  expect(active.getDraft()).toEqual(accepted)
  rerender({ current: source, initial, open: false })
  act(() => retireAgentPickerDrafts([{ ...source, catalog: { origin: 'unknown' } }], scope))
  expect(result.current.getDraft()).toEqual(accepted)
  act(() => retireAgentPickerDrafts([catalog([], false)], scope))
  expect(result.current.getDraft()).toEqual(accepted)
  act(() => retireAgentPickerDrafts([catalog([], true, true)], scope))
  expect(result.current.getDraft()).toEqual(accepted)
  act(() => retireAgentPickerDrafts([catalog([])], scope))
  expect(result.current.getDraft()).toBeUndefined()
  act(() => {
    active.activate()
    active.change({ ...accepted, pendingArguments: '--stale' })
    expect(active.accept(accepted)).toBe(false)
  })
  expect(result.current.getDraft()).toBeUndefined()
  rerender({ current: source, initial, open: true })
  expect(result.current.getDraft()).toEqual(initial)
  const beforeAuthority = result.current
  rerender({ current: { ...source, ownerKey: 'successor' }, initial, open: true })
  act(() => {
    beforeAuthority.activate()
    beforeAuthority.change(accepted)
    expect(beforeAuthority.accept(accepted)).toBe(false)
  })
  expect(result.current.getDraft()).toEqual(initial)
  const beforeDiscard = result.current
  act(() => invalidateAgentPickerDrafts(scope))
  act(() => {
    beforeDiscard.activate()
    beforeDiscard.change(accepted)
  })
  expect(beforeDiscard.getDraft()).toBeUndefined()
  rerender({ current: source, initial, open: true })
  const beforeTargetDeath = result.current
  act(() => retireAgentPickerDrafts([source], scope, () => false))
  act(() => {
    beforeTargetDeath.activate()
    beforeTargetDeath.change(accepted)
  })
  expect(beforeTargetDeath.getDraft()).toBeUndefined()
  rerender({ current: source, initial: { ...initial, arguments: '--replaced-source' }, open: true })
  expect(result.current.getDraft()).toHaveProperty('arguments', '--replaced-source')
  const disposed = result.current
  unmount()
  act(() => {
    disposed.activate()
    disposed.change(accepted)
    expect(disposed.accept(accepted)).toBe(false)
  })
  expect(disposed.getDraft()).toBeUndefined()
})
