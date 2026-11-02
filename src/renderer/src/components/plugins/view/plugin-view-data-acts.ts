import type { TestElement } from '../../../../../shared/plugins/declarative/testing/testing-tree'
import {
  enabledRow,
  expectType,
  isExpandable,
  nextSort,
  treeItem
} from '../../../../../shared/plugins/declarative/testing/testing-data-controls'
import type { PluginDeclarativeEventArg } from '../../../../../shared/plugins/declarative/plugin-declarative-messages'
import type {
  PluginShotAct,
  PluginShotQuery
} from '../../../../../shared/plugins/view/plugin-shot-acts'
import type {
  PluginDeclarativeActExpansion,
  PluginDeclarativeActTarget,
  PluginDeclarativeDrawnProps
} from '../declarative/plugin-declarative-act-targets'
import type { PluginPanelActDriver } from '../../right-sidebar/plugin-panel-act-driver'

export type PluginPanelActDeps = {
  driver: Pick<PluginPanelActDriver, 'tree' | 'send'>
  targetOf(props: PluginDeclarativeDrawnProps): PluginDeclarativeActTarget | null
  expansionOf(props: PluginDeclarativeDrawnProps): PluginDeclarativeActExpansion | null
  /** Resolves once the panel has drawn what the last act caused. */
  settle(): Promise<void>
}

/** What each verb needs of the drawn panel; built once per act list. */
export type PluginPanelActContext = {
  elements(): TestElement[]
  resolve(query: PluginShotQuery, verb: string): TestElement
  editable(element: TestElement, verb: string): PluginDeclarativeActTarget
  change(target: PluginDeclarativeActTarget, next: unknown, verb: string): void
  /** Sends `callback`, then settles; throws `missing` when the element has no such handler. */
  send(callback: string | null, args: PluginDeclarativeEventArg[], missing: string): Promise<void>
  expansionOf: PluginPanelActDeps['expansionOf']
  settle(): Promise<void>
}

export function callbackId(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    '$callback' in value &&
    typeof value.$callback === 'string'
    ? value.$callback
    : null
}

async function expandOrCollapse(
  tree: TestElement,
  key: string,
  open: boolean,
  context: PluginPanelActContext
): Promise<void> {
  const verb = open ? 'expand' : 'collapse'
  expectType(tree, 'Tree', verb)
  if (!isExpandable(treeItem(tree, key, verb))) {
    throw new Error(`${verb}: the Tree item "${key}" has no children`)
  }
  const expansion = context.expansionOf(tree.props)
  if (!expansion) {
    throw new Error(`${verb}: the Tree is not on screen`)
  }
  if (expansion.expanded().has(key) !== open) {
    expansion.set(key, open)
    await context.settle()
  }
}

/** Slider, Table and Tree verbs, with the test kit's checks and messages. */
export async function runPluginPanelDataAct(
  act: PluginShotAct,
  context: PluginPanelActContext
): Promise<void> {
  const { resolve, editable, change, send, settle } = context
  if ('slide' in act) {
    const slider = resolve(act.slide, 'slide')
    expectType(slider, 'Slider', 'slide')
    const min = typeof slider.props.min === 'number' ? slider.props.min : 0
    const max = typeof slider.props.max === 'number' ? slider.props.max : 100
    if (act.value < min || act.value > max) {
      throw new Error(`slide: ${act.value} is outside the Slider's ${min} to ${max}`)
    }
    change(editable(slider, 'slide'), act.value, 'slide')
    await settle()
  } else if ('sort' in act) {
    const table = resolve(act.sort, 'sort')
    expectType(table, 'Table', 'sort')
    const sort = nextSort(table, act.column)
    await send(callbackId(table.props.onSortChange), [sort], 'sort: the Table has no onSortChange')
  } else if ('selectRows' in act) {
    const table = resolve(act.selectRows, 'selectRows')
    expectType(table, 'Table', 'selectRows')
    const mode = table.props.selectionMode ?? 'none'
    if (mode === 'none' || (mode === 'single' && act.keys.length > 1)) {
      throw new Error(`selectRows: the Table's selectionMode is ${String(mode)}`)
    }
    act.keys.forEach((key) => enabledRow(table, key, 'selectRows'))
    change(editable(table, 'selectRows'), [...act.keys], 'selectRows')
    await settle()
  } else if ('activateRow' in act) {
    const table = resolve(act.activateRow, 'activateRow')
    expectType(table, 'Table', 'activateRow')
    enabledRow(table, act.key, 'activateRow')
    await send(
      callbackId(table.props.onRowAction),
      [{ key: act.key }],
      'activateRow: the Table has no onRowAction'
    )
  } else if ('loadMore' in act) {
    const table = resolve(act.loadMore, 'loadMore')
    expectType(table, 'Table', 'loadMore')
    const more = table.props.hasMore === true ? callbackId(table.props.onLoadMore) : null
    await send(more, [], 'loadMore: the Table has no more rows (hasMore and onLoadMore)')
  } else if ('expand' in act) {
    await expandOrCollapse(resolve(act.expand, 'expand'), act.key, true, context)
  } else if ('collapse' in act) {
    await expandOrCollapse(resolve(act.collapse, 'collapse'), act.key, false, context)
  } else if ('selectItem' in act) {
    const tree = resolve(act.selectItem, 'selectItem')
    expectType(tree, 'Tree', 'selectItem')
    if (treeItem(tree, act.key, 'selectItem').disabled === true) {
      throw new Error(`selectItem: the Tree item "${act.key}" is disabled`)
    }
    change(editable(tree, 'selectItem'), act.key, 'selectItem')
    await settle()
  } else if ('activateItem' in act) {
    const tree = resolve(act.activateItem, 'activateItem')
    expectType(tree, 'Tree', 'activateItem')
    const action = callbackId(tree.props.onAction)
    if (treeItem(tree, act.key, 'activateItem').disabled === true || action === null) {
      throw new Error(`activateItem: the Tree item "${act.key}" cannot be activated`)
    }
    await send(action, [{ key: act.key }], '')
  }
}
