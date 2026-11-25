import {
  pluginTableVisibleColumns,
  type PluginTableBreakpoint
} from '../plugin-declarative-table-columns'
import type { MockHost } from './testing-host'
import type { TestElement, TestQuery } from './testing-tree'
import type { ControlValue, createValueControls } from './testing-value-controls'
import { tabsOf } from './testing-visibility'
import {
  enabledRow,
  expectType,
  isExpandable,
  nextSort,
  tableRows,
  treeItem,
  treeItems
} from './testing-data-controls'

export type Target = TestElement | TestQuery

type Dependencies = {
  host: MockHost
  controls: ReturnType<typeof createValueControls>
  resolve: (target: Target, verb: string) => TestElement
  elements: () => TestElement[]
  dispatch: (callback: unknown, args: unknown[], edit?: number) => void
  settled: () => Promise<void>
}

/** A Select or RadioGroup's options, or a Tabs' tabs, as values a `select` may pick. */
export function optionsOf(element: TestElement, elements: readonly TestElement[]) {
  if (element.type === 'Tabs') {
    return tabsOf(element, elements).map((tab) => ({
      value: tab.props.value,
      disabled: tab.disabled
    }))
  }
  const options: unknown[] = Array.isArray(element.props.options) ? element.props.options : []
  return options.map((option) =>
    typeof option === 'object' && option !== null && 'value' in option
      ? { value: option.value, disabled: 'disabled' in option && option.disabled === true }
      : { value: undefined, disabled: true }
  )
}

/** Each act does what a person's input would, then resolves once the panel has settled. */
export function createPanelActions({
  host,
  controls,
  resolve,
  elements,
  dispatch,
  settled
}: Dependencies) {
  /** Expanded Tree items, per Tree, seeded from `defaultExpanded` as Orca seeds them. */
  const expanded = new Map<string, Set<string>>()
  const expandedOf = (tree: TestElement): Set<string> => {
    let keys = expanded.get(tree.path)
    if (!keys) {
      const seeded = tree.props.expanded ?? tree.props.defaultExpanded
      keys = new Set(Array.isArray(seeded) ? seeded.filter((key) => typeof key === 'string') : [])
      expanded.set(tree.path, keys)
    }
    return keys
  }
  const commit = async (
    element: TestElement,
    change: unknown,
    value: ControlValue,
    arg: unknown
  ) => {
    const edit = controls.edit(element, value)
    dispatch(change, [arg], edit.id)
    await settled()
  }
  const toggleTreeItem = async (target: Target, key: string, open: boolean, verb: string) => {
    const tree = resolve(target, verb)
    expectType(tree, 'Tree', verb)
    if (!isExpandable(treeItem(tree, key, verb))) {
      throw new Error(`${verb}: the Tree item "${key}" has no children`)
    }
    const keys = expandedOf(tree)
    if (keys.has(key) !== open) {
      if (open) {
        keys.add(key)
      } else {
        keys.delete(key)
      }
      dispatch(tree.props.onToggle, [{ key, expanded: open }])
      await settled()
    }
  }

  return {
    async press(target: Target): Promise<void> {
      const element = resolve(target, 'press')
      const { href, onPress } = element.props
      if (element.type === 'Link' && typeof href === 'string') {
        // Orca opens a Link's href itself, spending the press; onPress then runs without one.
        host.grantGesture()
        void host.bridge.call('shell.openExternal', { url: href }).catch(() => undefined)
      } else if (onPress === undefined) {
        throw new Error(`press: the ${element.type} has no onPress`)
      } else {
        host.grantGesture()
      }
      dispatch(onPress, [])
      await settled()
    },
    async type(target: Target, text: string, typing: { replace?: boolean; submit?: boolean } = {}) {
      const element = resolve(target, 'type')
      for (const edit of controls.typeInto(element, text, typing.replace === true)) {
        dispatch(element.props.onChange, [edit.value], edit.id)
        await settled()
      }
      if (typing.submit) {
        dispatch(element.props.onSubmit, [controls.valueOf(element)])
        await settled()
      }
    },
    async submit(target: Target): Promise<void> {
      const element = resolve(target, 'submit')
      dispatch(element.props.onSubmit, [controls.valueOf(element)])
      await settled()
    },
    async toggle(target: Target): Promise<void> {
      const element = resolve(target, 'toggle')
      const edit = controls.toggle(element)
      dispatch(element.props.onChange, [edit.value], edit.id)
      await settled()
    },
    /** A Select or RadioGroup option, or a Tabs tab, by value. */
    async select(target: Target, value: string): Promise<void> {
      const element = resolve(target, 'select')
      if (!['Select', 'RadioGroup', 'Tabs'].includes(element.type)) {
        throw new Error(`select: expected a Select, RadioGroup or Tabs, not a ${element.type}`)
      }
      const option = optionsOf(element, elements()).find((entry) => entry.value === value)
      if (!option || option.disabled) {
        throw new Error(`select: the ${element.type} has no enabled option "${value}"`)
      }
      await commit(element, element.props.onChange, value, value)
    },
    async slide(target: Target, value: number): Promise<void> {
      const element = resolve(target, 'slide')
      expectType(element, 'Slider', 'slide')
      const min = typeof element.props.min === 'number' ? element.props.min : 0
      const max = typeof element.props.max === 'number' ? element.props.max : 100
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`slide: ${value} is outside the Slider's ${min} to ${max}`)
      }
      await commit(element, element.props.onChange, value, value)
    },
    /** A header click: ascending first, then flipping. */
    async sort(target: Target, column: string): Promise<void> {
      const table = resolve(target, 'sort')
      expectType(table, 'Table', 'sort')
      if (table.props.onSortChange === undefined) {
        throw new Error('sort: the Table has no onSortChange')
      }
      dispatch(table.props.onSortChange, [nextSort(table, column)])
      await settled()
    },
    /** Replaces the selection with exactly these rows. */
    async selectRows(target: Target, keys: readonly string[]): Promise<void> {
      const table = resolve(target, 'selectRows')
      expectType(table, 'Table', 'selectRows')
      const mode = table.props.selectionMode ?? 'none'
      if (mode === 'none' || (mode === 'single' && keys.length > 1)) {
        throw new Error(`selectRows: the Table's selectionMode is ${String(mode)}`)
      }
      keys.forEach((key) => enabledRow(table, key, 'selectRows'))
      await commit(table, table.props.onSelectionChange, [...keys], { keys: [...keys] })
    },
    /** Enter or a double click on a row. */
    async activateRow(target: Target, key: string): Promise<void> {
      const table = resolve(target, 'activateRow')
      expectType(table, 'Table', 'activateRow')
      enabledRow(table, key, 'activateRow')
      if (table.props.onRowAction === undefined) {
        throw new Error('activateRow: the Table has no onRowAction')
      }
      dispatch(table.props.onRowAction, [{ key }])
      await settled()
    },
    /** Scrolls to the end of the loaded rows, as a person would. */
    async loadMore(target: Target): Promise<void> {
      const table = resolve(target, 'loadMore')
      expectType(table, 'Table', 'loadMore')
      if (table.props.hasMore !== true || table.props.onLoadMore === undefined) {
        throw new Error('loadMore: the Table has no more rows (hasMore and onLoadMore)')
      }
      dispatch(table.props.onLoadMore, [])
      await settled()
    },
    expand: (target: Target, key: string) => toggleTreeItem(target, key, true, 'expand'),
    collapse: (target: Target, key: string) => toggleTreeItem(target, key, false, 'collapse'),
    async selectItem(target: Target, key: string): Promise<void> {
      const tree = resolve(target, 'selectItem')
      expectType(tree, 'Tree', 'selectItem')
      if (treeItem(tree, key, 'selectItem').disabled === true) {
        throw new Error(`selectItem: the Tree item "${key}" is disabled`)
      }
      await commit(tree, tree.props.onSelect, key, { key })
    },
    async activateItem(target: Target, key: string): Promise<void> {
      const tree = resolve(target, 'activateItem')
      expectType(tree, 'Tree', 'activateItem')
      if (treeItem(tree, key, 'activateItem').disabled === true || !tree.props.onAction) {
        throw new Error(`activateItem: the Tree item "${key}" cannot be activated`)
      }
      dispatch(tree.props.onAction, [{ key }])
      await settled()
    },
    /** Which Tree items Orca shows expanded. */
    expandedOf: (target: Target): string[] => {
      const tree = resolve(target, 'expandedOf')
      expectType(tree, 'Tree', 'expandedOf')
      return treeItems(tree)
        .map((item) => item.key)
        .filter((key) => expandedOf(tree).has(key))
    },
    /** The keys of a Table's columns Orca shows at `width` px (wide when omitted), after `hideBelow`. */
    columnsOf: (target: Target, view: { width?: number } = {}): string[] => {
      const table = resolve(target, 'columnsOf')
      expectType(table, 'Table', 'columnsOf')
      const columns = Array.isArray(table.props.columns) ? table.props.columns : []
      const keyed = columns.flatMap(
        (column: unknown): { key: string; hideBelow?: PluginTableBreakpoint }[] => {
          if (typeof column !== 'object' || column === null || !('key' in column)) {
            return []
          }
          const hideBelow = 'hideBelow' in column ? column.hideBelow : undefined
          return typeof column.key === 'string'
            ? [
                {
                  key: column.key,
                  hideBelow: hideBelow === 'sm' || hideBelow === 'md' ? hideBelow : undefined
                }
              ]
            : []
        }
      )
      return pluginTableVisibleColumns(keyed, view.width ?? Number.POSITIVE_INFINITY).map(
        (column) => column.key
      )
    },
    /** The keys of a Table's rows, in the order Orca draws them. */
    rowsOf: (target: Target): string[] => {
      const table = resolve(target, 'rowsOf')
      expectType(table, 'Table', 'rowsOf')
      return tableRows(table).map((row) => row.key)
    }
  }
}
