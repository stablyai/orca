import { act, render } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import type { PluginDeclarativeNode } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginShotAct } from '../../../../../shared/plugins/view/plugin-shot-acts'
import { PluginDeclarativeView } from '../declarative/PluginDeclarativeView'
import type { PluginDeclarativeEmit } from '../declarative/PluginDeclarativeControls'
import {
  pluginDeclarativeActExpansion,
  pluginDeclarativeActTarget
} from '../declarative/plugin-declarative-act-targets'
import type { PluginPanelActDriver } from '../../right-sidebar/plugin-panel-act-driver'
import { runPluginPanelActs } from './plugin-view-acts'

export const cb = (id: string) => ({ $callback: id })
export const node = (
  type: string,
  props: Record<string, unknown> = {},
  children: unknown[] = []
) => ({ type, props, children })

function parse(raw: unknown): PluginDeclarativeNode {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  return parsed.tree
}

export type SentEvent = { callback: string; args: unknown[]; edit?: number }

/**
 * A fake guest under Orca's real drawn view: `build` is its render, `handle` its callbacks, and
 * each callback re-renders it, as a real guest's do. `run` drives it as `shot --act` would.
 */
export function mountActGuest(build: () => unknown, handle: (event: SentEvent) => void = () => {}) {
  const sent: SentEvent[] = []
  let tree: PluginDeclarativeNode | null = null
  const receive = (callback: string, args: unknown[], edit?: number): void => {
    const event = { callback, args, ...(edit === undefined ? {} : { edit }) }
    sent.push(event)
    handle(event)
    draw()
  }
  const onEvent: PluginDeclarativeEmit = (callback, args, options = {}) =>
    receive(callback, args, options.edit)
  const view = () => (
    <TooltipProvider>
      <PluginDeclarativeView tree={tree} onEvent={onEvent} />
    </TooltipProvider>
  )
  const result = render(view())
  function draw(): void {
    tree = parse(build())
    result.rerender(view())
  }
  act(() => draw())
  const driver: Pick<PluginPanelActDriver, 'tree' | 'send'> = {
    tree: () => tree,
    send: (callback, args) => act(() => receive(callback, args))
  }
  const run = (acts: PluginShotAct[]) =>
    runPluginPanelActs(acts, {
      driver,
      targetOf: pluginDeclarativeActTarget,
      expansionOf: pluginDeclarativeActExpansion,
      settle: () => act(async () => {})
    })
  return { sent, run }
}
