import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand, LayoutContext } from './workspace-layout-command-types'
import type { LayoutTerminalTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { checkWorkspaceLayoutModelRules, emptyLayoutBeside } from './workspace-layout-model-rules'

export const WS = 'repo-1::/Users/dev/orca'

/** Deterministic ids; pane ids are UUIDs as pane keys require. */
export function testContext(): LayoutContext {
  let id = 0
  let leaf = 0
  let clock = 1_700_000_000_000
  return {
    mintId: () => `id-${++id}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++leaf).padStart(12, '0')}`,
    now: () => (clock += 1000)
  }
}

export function emptyModel(): WorkspaceLayoutModel {
  return {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
}

/** Applies commands that must succeed and keep every structural rule. */
export function build(context: LayoutContext, commands: LayoutCommand[], model = emptyModel()) {
  let next = model
  const results = commands.map((command) => {
    const applied = applyLayoutCommand(next, command, context)
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    const violations = checkWorkspaceLayoutModelRules([applied.model], [next])
    if (violations.length > 0) {
      throw new Error(
        `${command.type} broke ${violations.map((violation) => violation.rule).join(', ')}`
      )
    }
    next = applied.model
    return applied.result
  })
  return { model: next, results }
}

export function terminalTab(model: WorkspaceLayoutModel, tabId: string): LayoutTerminalTab {
  const tab = model.workspaces[WS]!.tabs.find((entry) => entry.id === tabId)
  if (tab?.kind !== 'terminal') {
    throw new Error(`no terminal tab ${tabId}`)
  }
  return tab
}

/** A model with nothing beside it, as the Serializer and the rules check take it. */
export function asLoaded(layout: WorkspaceLayoutModel) {
  return { ...emptyLayoutBeside(), layout }
}
