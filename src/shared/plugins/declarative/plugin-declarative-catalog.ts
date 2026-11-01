import { z } from 'zod'
import { PLUGIN_PANEL_ICONS } from '../contributions/plugin-panel-contribution'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import { PLUGIN_DECLARATIVE_EDIT_PROP } from './plugin-declarative-message-names'

/** One icon vocabulary with the manifest's panel icons; unknown names draw a fallback glyph. */
export const PLUGIN_DECLARATIVE_ICONS = PLUGIN_PANEL_ICONS
export type PluginDeclarativeIconName = (typeof PLUGIN_DECLARATIVE_ICONS)[number]
export const PLUGIN_DECLARATIVE_ICON_SET: ReadonlySet<string> = new Set(PLUGIN_DECLARATIVE_ICONS)

export const PLUGIN_DECLARATIVE_CALLBACK_ID = /^[A-Za-z0-9_.:-]+$/
export const pluginDeclarativeCallbackSchema = z
  .object({
    $callback: z
      .string()
      .min(1)
      .max(LIMITS.maxCallbackIdLength)
      .regex(PLUGIN_DECLARATIVE_CALLBACK_ID)
  })
  .strict()
export type PluginDeclarativeCallback = z.infer<typeof pluginDeclarativeCallbackSchema>

/** The one colour vocabulary every component shares. */
export const PLUGIN_DECLARATIVE_TONES = [
  'neutral',
  'accent',
  'success',
  'warning',
  'danger'
] as const

const label = z.string().max(LIMITS.maxLabelLength)
const requiredLabel = label.min(1)
const callback = pluginDeclarativeCallbackSchema.optional()
// Why any short name: an unknown icon falls back to a glyph instead of rejecting the render.
const icon = z.string().regex(/^[a-z0-9-]{1,64}$/)
const gap = z.enum(['none', 'xs', 'sm', 'md', 'lg']).optional()
const align = z.enum(['start', 'center', 'end', 'stretch']).optional()
const tone = z.enum(PLUGIN_DECLARATIVE_TONES).optional()
const size = z.enum(['xs', 'sm', 'md']).optional()
const variant = z.enum(['solid', 'outline', 'ghost']).optional()
const flag = z.boolean().optional()
const text = z.string().max(LIMITS.maxTextLength)
/** Wire-only on value controls (see PLUGIN_DECLARATIVE_EDIT_PROP); authors never set it. */
const editAck = {
  [PLUGIN_DECLARATIVE_EDIT_PROP]: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
}

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
  .object({ variant, tone, size, icon: icon.optional(), disabled: flag, onPress: callback })
  .strict()
const iconButtonProps = z
  .object({ icon, label: requiredLabel, variant, tone, size, disabled: flag, onPress: callback })
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

/** What a component accepts as children: `inline` is text plus Text/Link/Code/Badge. */
export type PluginDeclarativeChildPolicy = 'none' | 'text' | 'inline' | 'items' | 'any'

function component<P extends z.ZodObject>(props: P, children: PluginDeclarativeChildPolicy) {
  return { props, children }
}

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
  Code: component(codeProps, 'text')
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
  new Set<PluginDeclarativeComponentName>(['Text', 'Link', 'Code', 'Badge'])
/** Controls a pressable ListItem may not contain: one row, one press target. */
export const PLUGIN_DECLARATIVE_INTERACTIVE_COMPONENTS: ReadonlySet<string> =
  new Set<PluginDeclarativeComponentName>([
    'Button',
    'IconButton',
    'Input',
    'Switch',
    'Select',
    'Link',
    'ListItem'
  ])

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
