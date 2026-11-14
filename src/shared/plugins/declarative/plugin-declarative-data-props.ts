import { z } from 'zod'
import { isPluginJsonObject } from '../manifest/plugin-json-object'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import { pluginRelativeTimeCellSchema } from './plugin-declarative-relative-time'
import {
  callback,
  component,
  editAck,
  flag,
  icon,
  itemKey,
  label,
  maxHeight,
  requiredLabel
} from './plugin-declarative-prop-schemas'

/** Data components added in catalog 2 (Orca 1.4.247): their content is data, not child nodes. */

const columnKey = z.string().min(1).max(64)
const cell = z.union([
  z.string().max(LIMITS.maxLabelLength),
  z.number(),
  z.boolean(),
  z.null(),
  pluginRelativeTimeCellSchema
])
const uniqueKeys = (items: readonly { key: string }[]): boolean =>
  new Set(items.map((item) => item.key)).size === items.length

const tableProps = z
  .object({
    label: requiredLabel,
    columns: z
      .array(
        z
          .object({
            key: columnKey,
            label: requiredLabel,
            align: z.enum(['start', 'center', 'end']).optional(),
            width: z.enum(['auto', 'xs', 'sm', 'md', 'lg']).optional(),
            /** An `auto` column's floor, so the main column keeps room in a narrow panel. */
            minWidth: z.enum(['auto', 'xs', 'sm', 'md']).optional(),
            /** Drop this column while the table is narrower than this (sm 360px, md 480px). */
            hideBelow: z.enum(['sm', 'md']).optional(),
            sortable: flag
          })
          .strict()
      )
      .min(1)
      .max(LIMITS.maxTableColumns)
      .refine(uniqueKeys, 'column keys must be unique'),
    rows: z
      .array(
        z
          .object({
            key: itemKey,
            cells: z
              .record(
                columnKey,
                cell.refine((value) => typeof value !== 'number' || Number.isFinite(value))
              )
              .refine((cells) => Object.keys(cells).length <= LIMITS.maxTableColumns),
            disabled: flag
          })
          .strict()
      )
      .max(LIMITS.maxTableRows)
      .refine(uniqueKeys, 'row keys must be unique'),
    sort: z
      .object({ column: columnKey, direction: z.enum(['asc', 'desc']) })
      .strict()
      .optional(),
    selectionMode: z.enum(['none', 'single', 'multiple']).optional(),
    selected: z.array(itemKey).max(LIMITS.maxTableRows).optional(),
    defaultSelected: z.array(itemKey).max(LIMITS.maxTableRows).optional(),
    /** More rows exist than `rows` holds: scrolling near the end calls `onLoadMore`. */
    hasMore: flag,
    loading: flag,
    emptyText: label.optional(),
    maxHeight,
    onSortChange: callback,
    onSelectionChange: callback,
    onRowAction: callback,
    onLoadMore: callback,
    ...editAck
  })
  .strict()

export type PluginDeclarativeTreeItem = {
  key: string
  label: string
  description?: string
  icon?: string
  disabled?: boolean
  /** Children exist but are not loaded yet: expanding shows a loading row and calls `onToggle`. */
  hasChildren?: boolean
  children?: PluginDeclarativeTreeItem[]
}

const treeItemFields = z
  .object({
    key: itemKey,
    label: requiredLabel,
    description: label.optional(),
    icon: icon.optional(),
    disabled: flag,
    hasChildren: flag,
    children: z.array(z.unknown()).optional()
  })
  .strict()

/** Iterative so a deep item list costs no stack; null names the first problem. */
function parseTreeItems(raw: unknown[]): PluginDeclarativeTreeItem[] | string {
  const root: PluginDeclarativeTreeItem[] = []
  const keys = new Set<string>()
  const pending: { raw: unknown[]; out: PluginDeclarativeTreeItem[]; depth: number }[] = [
    { raw, out: root, depth: 1 }
  ]
  let count = 0
  for (let level = pending.pop(); level; level = pending.pop()) {
    if (level.depth > LIMITS.maxTreeItemDepth) {
      return `items nest deeper than ${LIMITS.maxTreeItemDepth}`
    }
    for (const entry of level.raw) {
      if (++count > LIMITS.maxTreeItems) {
        return `more than ${LIMITS.maxTreeItems} items`
      }
      const parsed = treeItemFields.safeParse(isPluginJsonObject(entry) ? entry : null)
      if (!parsed.success) {
        return 'each item needs a key and a label'
      }
      const { children, ...fields } = parsed.data
      if (keys.has(fields.key)) {
        return `duplicate item key ${JSON.stringify(fields.key.slice(0, 64))}`
      }
      keys.add(fields.key)
      const item: PluginDeclarativeTreeItem = fields
      level.out.push(item)
      if (children) {
        item.children = []
        pending.push({ raw: children, out: item.children, depth: level.depth + 1 })
      }
    }
  }
  return root
}

const treeItems = z.array(z.unknown()).transform((raw, context) => {
  const parsed = parseTreeItems(raw)
  if (typeof parsed === 'string') {
    context.addIssue({ code: 'custom', message: parsed })
    return z.NEVER
  }
  return parsed
})

const treeProps = z
  .object({
    label: requiredLabel,
    items: treeItems,
    /** `''` selects nothing. */
    selected: label.optional(),
    defaultSelected: label.optional(),
    /** Which items are open, kept by the plugin (with `onToggle`) so it survives a remount. */
    expanded: z.array(itemKey).max(LIMITS.maxTreeItems).optional(),
    defaultExpanded: z.array(itemKey).max(LIMITS.maxTreeItems).optional(),
    maxHeight,
    /** `{ key }` of the item the person selected. */
    onSelect: callback,
    /** `{ key, expanded }` on every expand or collapse; load lazy children here. */
    onToggle: callback,
    /** `{ key }` on Enter or a double click. */
    onAction: callback,
    ...editAck
  })
  .strict()

export const PLUGIN_DECLARATIVE_DATA_CATALOG = {
  Table: component(tableProps, 'none'),
  Tree: component(treeProps, 'none')
} as const
