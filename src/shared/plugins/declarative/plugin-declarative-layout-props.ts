import { z } from 'zod'
import {
  callback,
  component,
  editAck,
  flag,
  gap,
  icon,
  label,
  requiredLabel
} from './plugin-declarative-prop-schemas'

/** Layout components added in catalog 2 (Orca 1.4.247). */

const tabsProps = z
  .object({
    label: requiredLabel,
    value: label.optional(),
    defaultValue: label.optional(),
    onChange: callback,
    ...editAck
  })
  .strict()
const tabProps = z
  .object({ value: requiredLabel, label: requiredLabel, icon: icon.optional(), disabled: flag })
  .strict()
const collapsibleProps = z
  .object({
    title: requiredLabel,
    description: label.optional(),
    open: flag,
    defaultOpen: flag,
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const toolbarProps = z.object({ label: requiredLabel, gap }).strict()
const gridProps = z
  .object({
    /** Fixed column count; ignored when `minItemWidth` is set. */
    columns: z.number().int().min(1).max(6).optional(),
    /** As many columns as fit, each at least this wide. */
    minItemWidth: z.enum(['xs', 'sm', 'md', 'lg']).optional(),
    gap
  })
  .strict()

export const PLUGIN_DECLARATIVE_LAYOUT_CATALOG = {
  Tabs: component(tabsProps, 'tabs'),
  Tab: component(tabProps, 'any'),
  Collapsible: component(collapsibleProps, 'any'),
  Toolbar: component(toolbarProps, 'any'),
  Grid: component(gridProps, 'any')
} as const
