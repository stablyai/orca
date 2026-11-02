import { z } from 'zod'
import { PLUGIN_PANEL_ICONS } from '../contributions/plugin-panel-contribution'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import {
  align,
  callback,
  component,
  editAck,
  flag,
  gap,
  icon,
  label,
  requiredLabel,
  size,
  text,
  tone,
  variant
} from './plugin-declarative-prop-schemas'
import type { PLUGIN_DECLARATIVE_TONES } from './plugin-declarative-prop-schemas'
import { PLUGIN_DECLARATIVE_FORM_CATALOG } from './plugin-declarative-form-props'
import { PLUGIN_DECLARATIVE_LAYOUT_CATALOG } from './plugin-declarative-layout-props'
import { PLUGIN_DECLARATIVE_DATA_CATALOG } from './plugin-declarative-data-props'
import { PLUGIN_DECLARATIVE_CONTENT_CATALOG } from './plugin-declarative-content-props'

export {
  PLUGIN_DECLARATIVE_CALLBACK_ID,
  PLUGIN_DECLARATIVE_TONES,
  pluginDeclarativeCallbackSchema,
  type PluginDeclarativeCallback,
  type PluginDeclarativeChildPolicy
} from './plugin-declarative-prop-schemas'

/** One icon vocabulary with the manifest's panel icons; unknown names draw a fallback glyph. */
export const PLUGIN_DECLARATIVE_ICONS = PLUGIN_PANEL_ICONS
export type PluginDeclarativeIconName = (typeof PLUGIN_DECLARATIVE_ICONS)[number]
export const PLUGIN_DECLARATIVE_ICON_SET: ReadonlySet<string> = new Set(PLUGIN_DECLARATIVE_ICONS)

const stackProps = z.object({ gap, align }).strict()
const rowProps = z
  .object({
    gap,
    align,
    justify: z.enum(['start', 'center', 'end', 'between']).optional(),
    wrap: flag
  })
  .strict()
const textProps = z
  .object({
    tone,
    muted: flag,
    size,
    weight: z.enum(['regular', 'medium', 'semibold']).optional(),
    truncate: flag
  })
  .strict()
const headingProps = z
  .object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() })
  .strict()
const buttonProps = z
  .object({
    variant,
    tone,
    size,
    icon: icon.optional(),
    tooltip: label.optional(),
    disabled: flag,
    onPress: callback
  })
  .strict()
const iconButtonProps = z
  .object({
    icon,
    label: requiredLabel,
    tooltip: label.optional(),
    variant,
    tone,
    size,
    disabled: flag,
    onPress: callback
  })
  .strict()
const badgeProps = z.object({ tone }).strict()
const cardProps = z.object({ title: label.optional(), description: label.optional() }).strict()
const listProps = z.object({ label: label.optional() }).strict()
const listItemProps = z
  .object({
    title: label.optional(),
    description: label.optional(),
    icon: icon.optional(),
    current: flag,
    disabled: flag,
    onPress: callback
  })
  .strict()
const inputProps = z
  .object({
    label: requiredLabel,
    labelHidden: flag,
    value: text.optional(),
    defaultValue: text.optional(),
    placeholder: label.optional(),
    type: z.enum(['text', 'search', 'password']).optional(),
    maxLength: z.number().int().positive().max(LIMITS.maxTextLength).optional(),
    invalid: flag,
    disabled: flag,
    onChange: callback,
    onSubmit: callback,
    ...editAck
  })
  .strict()
const switchProps = z
  .object({
    label: requiredLabel,
    checked: flag,
    defaultChecked: flag,
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const selectProps = z
  .object({
    label: requiredLabel,
    labelHidden: flag,
    value: label.optional(),
    defaultValue: label.optional(),
    placeholder: label.optional(),
    options: z
      .array(z.object({ value: requiredLabel, label: requiredLabel, disabled: flag }).strict())
      .max(LIMITS.maxSelectOptions),
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const separatorProps = z
  .object({ orientation: z.enum(['horizontal', 'vertical']).optional() })
  .strict()
const progressProps = z
  .object({ label: requiredLabel, labelHidden: flag, value: z.number().min(0).max(100).optional() })
  .strict()
const spinnerProps = z.object({ label: requiredLabel, labelHidden: flag }).strict()
const emptyStateProps = z
  .object({ title: requiredLabel, description: label.optional(), icon: icon.optional() })
  .strict()
const linkProps = z
  .object({
    // Why no `javascript:`/`file:`: the host opens it in the OS browser, never in Orca.
    href: z
      .string()
      .max(2048)
      .regex(/^(https?:\/\/|mailto:)/i)
      .optional(),
    onPress: callback
  })
  .strict()
const codeProps = z.object({ block: flag }).strict()

export const PLUGIN_DECLARATIVE_CATALOG = {
  Stack: component(stackProps, 'any'),
  Row: component(rowProps, 'any'),
  Text: component(textProps, 'inline'),
  Heading: component(headingProps, 'inline'),
  Button: component(buttonProps, 'text'),
  IconButton: component(iconButtonProps, 'none'),
  Badge: component(badgeProps, 'text'),
  Card: component(cardProps, 'any'),
  List: component(listProps, 'items'),
  ListItem: component(listItemProps, 'any'),
  Input: component(inputProps, 'none'),
  Switch: component(switchProps, 'none'),
  Select: component(selectProps, 'none'),
  Separator: component(separatorProps, 'none'),
  Progress: component(progressProps, 'none'),
  Spinner: component(spinnerProps, 'none'),
  EmptyState: component(emptyStateProps, 'any'),
  Link: component(linkProps, 'text'),
  Code: component(codeProps, 'text'),
  ...PLUGIN_DECLARATIVE_FORM_CATALOG,
  ...PLUGIN_DECLARATIVE_LAYOUT_CATALOG,
  ...PLUGIN_DECLARATIVE_DATA_CATALOG,
  ...PLUGIN_DECLARATIVE_CONTENT_CATALOG
} as const

export type PluginDeclarativeComponentName = keyof typeof PLUGIN_DECLARATIVE_CATALOG

export function isPluginDeclarativeComponentName(
  name: unknown
): name is PluginDeclarativeComponentName {
  return typeof name === 'string' && Object.hasOwn(PLUGIN_DECLARATIVE_CATALOG, name)
}

export const PLUGIN_DECLARATIVE_COMPONENT_NAMES: readonly PluginDeclarativeComponentName[] =
  Object.keys(PLUGIN_DECLARATIVE_CATALOG).filter(isPluginDeclarativeComponentName)
export const PLUGIN_DECLARATIVE_INLINE_COMPONENTS: ReadonlySet<string> =
  new Set<PluginDeclarativeComponentName>(['Text', 'Link', 'Code', 'Badge', 'RelativeTime'])
/** Controls a pressable ListItem may not contain: one row, one press target. */
export const PLUGIN_DECLARATIVE_INTERACTIVE_COMPONENTS: ReadonlySet<string> =
  new Set<PluginDeclarativeComponentName>([
    'Button',
    'IconButton',
    'Input',
    'Switch',
    'Select',
    'Link',
    'ListItem',
    'Textarea',
    'Checkbox',
    'RadioGroup',
    'Slider',
    'Tabs',
    'Collapsible',
    'Table',
    'Tree',
    'Markdown'
  ])
/** Components that hold only one child type, and that child's only parent. */
export const PLUGIN_DECLARATIVE_SLOT_CHILDREN = { items: 'ListItem', tabs: 'Tab' } as const

export type PluginDeclarativeProps<T extends PluginDeclarativeComponentName> = z.infer<
  (typeof PLUGIN_DECLARATIVE_CATALOG)[T]['props']
>
export type PluginDeclarativeTone = (typeof PLUGIN_DECLARATIVE_TONES)[number]

/** A component this Orca does not know (a newer catalog, or a typo): drawn as a neutral placeholder. */
export type PluginDeclarativeUnsupportedNode = {
  type: 'Unsupported'
  key?: string
  props: { name: string }
  children: []
}

export type PluginDeclarativeNode =
  | {
      [T in PluginDeclarativeComponentName]: {
        type: T
        key?: string
        props: PluginDeclarativeProps<T>
        children: PluginDeclarativeChild[]
      }
    }[PluginDeclarativeComponentName]
  | PluginDeclarativeUnsupportedNode
/** Numbers are normalized to strings during validation. */
export type PluginDeclarativeChild = PluginDeclarativeNode | string
