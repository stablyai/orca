// Extends the seeded model test of #26073 (terminal-topology-model.test.ts) to the layout module:
// the same seeds and plain reference model, now driven by layout commands from two clients and by
// process exits, with the structural rules (and id stability) checked after every step and a
// save/load round trip standing in for quit and relaunch.
// Replay one seed: FUZZ_SEED=<n> FUZZ_ITERATIONS=1 pnpm test <this file>.

import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../agent-tui-ansi-fuzz-stream'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand, LayoutContext } from './workspace-layout-command-types'
import { emptyModel, testContext } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { checkWorkspaceLayoutModelRules, emptyLayoutBeside } from './workspace-layout-model-rules'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { applyLayoutTransition, type LayoutTransition } from './workspace-layout-transitions'

const WORKSPACES = ['repo-1::/fixture/local', 'folder:folder-1', FLOATING_TERMINAL_WORKTREE_ID]
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 0x9417)
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 6)
const OPS_PER_SEED = 60

/** What the runtime must hold: workspace → terminal tab → pane → bound terminal. */
type Reference = Map<string, Map<string, Map<string, string | undefined>>>

type Step = { label: string; command?: LayoutCommand; transition?: LayoutTransition }

function project(model: WorkspaceLayoutModel) {
  return Object.fromEntries(
    WORKSPACES.map((key) => {
      const tabs = (model.workspaces[key]?.tabs ?? []).flatMap((tab) =>
        tab.kind === 'terminal'
          ? [
              [
                tab.entityId,
                Object.fromEntries(
                  collectLayoutLeafIdsInOrder(tab.panes.root).map((leafId) => [
                    leafId,
                    model.workspaces[key]!.leaves?.[leafId]?.ptyId
                  ])
                )
              ]
            ]
          : []
      )
      return [key, Object.fromEntries(tabs)]
    })
  )
}

function expected(reference: Reference) {
  return Object.fromEntries(
    WORKSPACES.map((key) => [
      key,
      Object.fromEntries(
        [...(reference.get(key) ?? [])].map(([tabId, leaves]) => [
          tabId,
          Object.fromEntries(leaves)
        ])
      )
    ])
  )
}

class Harness {
  model = emptyModel()
  reference: Reference = new Map(WORKSPACES.map((key) => [key, new Map()]))
  readonly log: string[] = []
  private ptyCounter = 0

  constructor(readonly context: LayoutContext) {}

  newPtyId(): string {
    return `pty-${++this.ptyCounter}`
  }

  /** Applies one step, checks the rules against the previous model, returns whether it applied. */
  apply(step: Step): ReturnType<typeof applyLayoutCommand> {
    const result = step.command
      ? applyLayoutCommand(this.model, step.command, this.context)
      : applyLayoutTransition(this.model, step.transition!)
    this.log.push(`${step.label} → ${result.ok ? 'ok' : result.code}`)
    if (result.ok) {
      expect(
        checkWorkspaceLayoutModelRules([result.model], [this.model]),
        this.log.join('\n')
      ).toEqual([])
      this.model = result.model
    }
    return result
  }

  /** A step the reference says must apply. */
  must(step: Step) {
    const result = this.apply(step)
    if (!result.ok) {
      throw new Error(`expected ${step.label} to apply:\n${this.log.join('\n')}`)
    }
    return result
  }

  panes(): { key: string; tabId: string; leafId: string; ptyId: string | undefined }[] {
    return [...this.reference].flatMap(([key, tabs]) =>
      [...tabs].flatMap(([tabId, leaves]) =>
        [...leaves].map(([leafId, ptyId]) => ({ key, tabId, leafId, ptyId }))
      )
    )
  }

  removePane(key: string, tabId: string, leafId: string): void {
    const tabs = this.reference.get(key)!
    tabs.get(tabId)?.delete(leafId)
    if (tabs.get(tabId)?.size === 0) {
      tabs.delete(tabId)
    }
  }

  reopen(): void {
    const saved = saveWorkspaceLayout({ ...emptyLayoutBeside(), layout: this.model })
    let minted = 0
    const loaded = loadWorkspaceLayout(this.model.hostId, saved, {
      mintId: () => `reload-${++minted}`,
      mintLeafId: () => `reload-leaf-${++minted}`
    })
    expect(loaded.changes, this.log.join('\n')).toEqual([])
    expect(saveWorkspaceLayout({ ...emptyLayoutBeside(), layout: loaded.layout })).toEqual(saved)
    this.model = loaded.layout
    this.log.push('reopen')
  }
}

/** Two clients race on one pane or tab; the runtime applies whichever it reads first. */
type Race = 'close-tab-vs-split' | 'close-pane-vs-drag-out' | 'exit-vs-close-tab'

function runRace(
  harness: Harness,
  race: Race,
  pane: ReturnType<Harness['panes']>[number],
  closeFirst: boolean
): void {
  const { key, tabId, leafId } = pane
  const closeTab: Step = {
    label: `A closeTabs ${tabId}`,
    command: { type: 'closeTabs', workspace: key, tabIds: [tabId] }
  }
  const closePane: Step = {
    label: `A closePane ${leafId}`,
    command: { type: 'closePane', workspace: key, tabId, leafId }
  }
  const other: Step =
    race === 'close-tab-vs-split'
      ? {
          label: `B splitPane ${leafId}`,
          command: { type: 'splitPane', workspace: key, tabId, leafId, direction: 'horizontal' }
        }
      : race === 'close-pane-vs-drag-out'
        ? {
            label: `B movePaneToNewTab ${leafId}`,
            command: { type: 'movePaneToNewTab', workspace: key, tabId, leafId }
          }
        : {
            label: `exited ${leafId}`,
            transition: {
              type: 'processExited',
              surface: { worktreeId: key, terminalTabId: tabId, leafId, ptyId: pane.ptyId! }
            }
          }
  const closing = race === 'close-pane-vs-drag-out' ? closePane : closeTab
  const order = closeFirst ? [closing, other] : [other, closing]
  for (const step of order) {
    const result = harness.apply(step)
    if (!result.ok) {
      continue
    }
    if (step === closing) {
      if (race === 'close-pane-vs-drag-out') {
        // The pane may already live in the dragged-out tab; then this close finds nothing.
        if (harness.reference.get(key)!.get(tabId)?.has(leafId)) {
          harness.removePane(key, tabId, leafId)
        }
      } else {
        harness.reference.get(key)!.delete(tabId)
      }
    } else if (race === 'close-tab-vs-split' && result.result.leafId) {
      harness.reference.get(key)!.get(tabId)!.set(result.result.leafId, undefined)
    } else if (race === 'close-pane-vs-drag-out' && result.result.tabId) {
      const ptyId = harness.reference.get(key)!.get(tabId)!.get(leafId)
      harness.removePane(key, tabId, leafId)
      harness.reference.get(key)!.set(result.result.tabId, new Map([[leafId, ptyId]]))
    } else if (
      race === 'exit-vs-close-tab' &&
      harness.reference.get(key)!.get(tabId)?.has(leafId)
    ) {
      harness.removePane(key, tabId, leafId)
    }
  }
}

function runSeed(seed: number): string[] {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)]
  const harness = new Harness(testContext())
  const ops = [
    'create',
    'create',
    'split',
    'bind',
    'bind',
    'exit',
    'closePane',
    'closeTab',
    'dragOut',
    'movePane',
    'moveTab',
    'equalize',
    'sleepWake',
    'race',
    'reopen'
  ] as const
  for (let step = 0; step < OPS_PER_SEED; step++) {
    const op = pick(ops)!
    const pane = pick(harness.panes())
    const client = random() < 0.5 ? 'A' : 'B'
    if (op === 'create' || !pane) {
      const key = pick(WORKSPACES)!
      const result = harness.must({
        label: `${client} createTerminalTab ${key}`,
        command: { type: 'createTerminalTab', workspace: key }
      })
      harness.reference
        .get(key)!
        .set(result.result.tabId!, new Map([[result.result.leafId!, undefined]]))
    } else if (op === 'split') {
      const result = harness.must({
        label: `${client} splitPane ${pane.leafId}`,
        command: {
          type: 'splitPane',
          workspace: pane.key,
          tabId: pane.tabId,
          leafId: pane.leafId,
          direction: random() < 0.5 ? 'vertical' : 'horizontal'
        }
      })
      harness.reference.get(pane.key)!.get(pane.tabId)!.set(result.result.leafId!, undefined)
    } else if (op === 'bind' && !pane.ptyId) {
      const ptyId = harness.newPtyId()
      harness.must({
        label: `started ${pane.leafId} ${ptyId}`,
        transition: {
          type: 'processStarted',
          workspace: pane.key,
          paneKey: `${pane.tabId}:${pane.leafId}`,
          ptyId
        }
      })
      harness.reference.get(pane.key)!.get(pane.tabId)!.set(pane.leafId, ptyId)
    } else if (op === 'exit' && pane.ptyId) {
      harness.must({
        label: `exited ${pane.leafId}`,
        transition: {
          type: 'processExited',
          surface: {
            worktreeId: pane.key,
            terminalTabId: pane.tabId,
            leafId: pane.leafId,
            ptyId: pane.ptyId
          }
        }
      })
      harness.removePane(pane.key, pane.tabId, pane.leafId)
    } else if (op === 'closePane') {
      harness.must({
        label: `${client} closePane ${pane.leafId}`,
        command: { type: 'closePane', workspace: pane.key, tabId: pane.tabId, leafId: pane.leafId }
      })
      harness.removePane(pane.key, pane.tabId, pane.leafId)
    } else if (op === 'closeTab') {
      harness.must({
        label: `${client} closeTabs ${pane.tabId}`,
        command: { type: 'closeTabs', workspace: pane.key, tabIds: [pane.tabId] }
      })
      harness.reference.get(pane.key)!.delete(pane.tabId)
    } else if (op === 'dragOut' && harness.reference.get(pane.key)!.get(pane.tabId)!.size > 1) {
      const result = harness.must({
        label: `${client} movePaneToNewTab ${pane.leafId}`,
        command: {
          type: 'movePaneToNewTab',
          workspace: pane.key,
          tabId: pane.tabId,
          leafId: pane.leafId
        }
      })
      harness.removePane(pane.key, pane.tabId, pane.leafId)
      harness.reference
        .get(pane.key)!
        .set(result.result.tabId!, new Map([[pane.leafId, pane.ptyId]]))
    } else if (op === 'movePane') {
      const target = pick(
        [...harness.reference.get(pane.key)!.get(pane.tabId)!.keys()].filter(
          (leafId) => leafId !== pane.leafId
        )
      )
      if (target) {
        harness.must({
          label: `${client} movePane ${pane.leafId}`,
          command: {
            type: 'movePane',
            workspace: pane.key,
            tabId: pane.tabId,
            leafId: pane.leafId,
            targetLeafId: target,
            side: pick(['left', 'right', 'top', 'bottom'] as const)!
          }
        })
      }
    } else if (op === 'moveTab') {
      const groups = harness.model.workspaces[pane.key]!.groups
      const command: LayoutCommand =
        random() < 0.5
          ? {
              type: 'splitGroup',
              workspace: pane.key,
              tabId: pane.tabId,
              besideGroupId: pick(groups)!.id,
              direction: pick(['left', 'right', 'up', 'down'] as const)!
            }
          : {
              type: 'moveTab',
              workspace: pane.key,
              tabId: pane.tabId,
              toGroupId: pick(groups)!.id,
              index: Math.floor(random() * 4)
            }
      harness.apply({ label: `${client} ${command.type} ${pane.tabId}`, command })
    } else if (op === 'equalize') {
      harness.must({
        label: `${client} equalizePanes ${pane.tabId}`,
        command: { type: 'equalizePanes', workspace: pane.key, tabId: pane.tabId }
      })
    } else if (op === 'sleepWake') {
      const paneKey = `${pane.tabId}:${pane.leafId}`
      const record = {
        paneKey,
        tabId: pane.tabId,
        worktreeId: pane.key,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: `s-${pane.leafId}` },
        prompt: 'p',
        state: 'done' as const,
        capturedAt: 1,
        updatedAt: 1
      }
      harness.must({
        label: `${client} sleep ${paneKey}`,
        command: { type: 'sleep', workspace: pane.key, paneKeys: [paneKey], records: [record] }
      })
      harness.must({
        label: `${client} wake ${paneKey}`,
        command: { type: 'wake', workspace: pane.key, paneKeys: [paneKey] }
      })
    } else if (op === 'race') {
      // An exit names the terminal it ended, so only a bound pane can race one.
      const races: Race[] = pane.ptyId
        ? ['close-tab-vs-split', 'close-pane-vs-drag-out', 'exit-vs-close-tab']
        : ['close-tab-vs-split', 'close-pane-vs-drag-out']
      runRace(harness, pick(races)!, pane, random() < 0.5)
    } else if (op === 'reopen') {
      harness.reopen()
    }
    expect(project(harness.model), `seed ${seed}:\n${harness.log.join('\n')}`).toEqual(
      expected(harness.reference)
    )
  }
  harness.reopen()
  expect(project(harness.model), `seed ${seed}, after reopen:\n${harness.log.join('\n')}`).toEqual(
    expected(harness.reference)
  )
  return harness.log
}

describe('workspace layout commands (seeded model)', () => {
  it('keeps one tab per pane, one pane per terminal, stable ids and the expected layout across random commands', () => {
    const ran = new Set<string>()
    for (let seed = FIRST_SEED; seed < FIRST_SEED + ITERATIONS; seed++) {
      for (const entry of runSeed(seed)) {
        ran.add(entry.split(' ')[1] ?? entry)
      }
    }
    // No empty passes: every command and transition the seeds draw from actually ran.
    for (const name of [
      'createTerminalTab',
      'splitPane',
      'closePane',
      'closeTabs',
      'movePaneToNewTab',
      'movePane',
      'equalizePanes',
      'sleep',
      'wake'
    ]) {
      expect(ran, name).toContain(name)
    }
  })
})
