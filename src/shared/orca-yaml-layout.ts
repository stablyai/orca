// Why: shared because main parses + validates the YAML and the
// renderer reads the resolved types at every entity-create call.

import { z } from 'zod'

/**
 * Anchor positions for declared layout groups. Two-axis values compose
 * horizontal-then-vertical splits at materialization time; single-axis
 * values produce a single split; `center` is the root group.
 */
export const LAYOUT_GROUP_POSITIONS = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'left-top',
  'left-bottom',
  'right-top',
  'right-bottom'
] as const

export type LayoutGroupPosition = (typeof LAYOUT_GROUP_POSITIONS)[number]

const LayoutGroupPositionSchema = z.enum(LAYOUT_GROUP_POSITIONS)

// Why: `mixed` / undefined accepts every content type — explicit kinds
// reject mismatched content at create time and on drag-drop.
export const LAYOUT_GROUP_KINDS = ['editor', 'terminal', 'browser', 'mixed'] as const
export type LayoutGroupKind = (typeof LAYOUT_GROUP_KINDS)[number]

const LayoutGroupKindSchema = z.enum(LAYOUT_GROUP_KINDS)

const MAX_LAYOUT_GROUPS = 24
const MAX_LAYOUT_GROUP_NAME_LENGTH = 64
const UNSAFE_LAYOUT_GROUP_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

// Why: group names come from untrusted repo config and become object-map
// keys plus CLI arguments, so keep them bounded and prototype-safe.
const LayoutGroupNameSchema = z
  .string()
  .min(1)
  .max(MAX_LAYOUT_GROUP_NAME_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: 'Group names may contain only letters, numbers, underscores, and hyphens'
  })
  .refine((name) => !UNSAFE_LAYOUT_GROUP_NAMES.has(name), {
    message: 'Group name is reserved'
  })

const LayoutGroupSchema = z.object({
  position: LayoutGroupPositionSchema,
  kind: LayoutGroupKindSchema.optional()
})

export type LayoutGroupConfig = z.infer<typeof LayoutGroupSchema>

/**
 * True when a group whose declared kind is `groupKind` accepts a
 * content of `contentKind`. `mixed` (or undefined) accepts everything;
 * a specific kind only accepts its matching content kind.
 *
 * `editor` content kind family covers `editor`, `diff`, `conflict-review`.
 */
export function groupAllowsContentKind(
  groupKind: LayoutGroupKind | undefined,
  contentKind: string
): boolean {
  if (!groupKind || groupKind === 'mixed') {
    return true
  }
  const ruleKey = ruleKeyForContentKind(contentKind)
  if (!ruleKey) {
    // Unknown content kind (settings, sidekick, etc.) — don't enforce
    // anything; let it land where the caller asked.
    return true
  }
  switch (groupKind) {
    case 'editor':
      return ruleKey === 'new-editor-tab'
    case 'terminal':
      return ruleKey === 'new-terminal'
    case 'browser':
      return ruleKey === 'new-browser-tab'
    default:
      return true
  }
}

// Why: forward-compat. Future rule keys land in `LAYOUT_RULE_KEYS`;
// older Orca builds parsing a future config strip unknown keys silently
// (Zod default) instead of failing the whole layout block.
export const LAYOUT_RULE_KEYS = ['new-editor-tab', 'new-terminal', 'new-browser-tab'] as const

export type LayoutRuleKey = (typeof LAYOUT_RULE_KEYS)[number]

/**
 * Map from a content-creation event (e.g. `new-terminal`) to a declared
 * group name. Group name must exist in `groups` — validated at parse time.
 *
 * Why z.object instead of z.record(enum, string): Zod 4 narrowed
 * `z.record` to a single-arg form for value-only constraints; we need
 * the explicit per-key shape so a literal object schema is the right
 * fit, plus it surfaces "unknown rule key" softly (extra keys are
 * dropped, not hard errors — older Orca shouldn't break on a future
 * rule key written by newer config).
 */
const LayoutRulesSchema = z.object({
  'new-editor-tab': LayoutGroupNameSchema.optional(),
  'new-terminal': LayoutGroupNameSchema.optional(),
  'new-browser-tab': LayoutGroupNameSchema.optional()
})

export type LayoutRules = Partial<Record<LayoutRuleKey, string>>

/**
 * Top-level layout block from orca.yaml. Both `groups` and `rules` are
 * optional — a config with only `groups` defined is valid (rules fall
 * back to current Orca behavior of placing into `activeGroupId`).
 */
export const LayoutConfigSchema = z
  .object({
    groups: z
      .record(LayoutGroupNameSchema, LayoutGroupSchema)
      .refine((groups) => Object.keys(groups).length <= MAX_LAYOUT_GROUPS, {
        message: `Layout may declare at most ${MAX_LAYOUT_GROUPS} groups`
      })
      .optional(),
    rules: LayoutRulesSchema.optional()
  })
  .refine(
    (config) => {
      if (!config.rules || !config.groups) {
        return true
      }
      return Object.values(config.rules)
        .filter((v): v is string => typeof v === 'string')
        .every((groupName) => Object.prototype.hasOwnProperty.call(config.groups!, groupName))
    },
    {
      message: 'Every rule must reference a group declared in `groups`'
    }
  )
  .refine(
    (config) => {
      // Why: catch e.g. `new-terminal: editorPane` where editorPane has
      // `kind: editor` — runtime would silently fall back; schema-time
      // failure surfaces the typo while the user is still editing yaml.
      if (!config.rules || !config.groups) {
        return true
      }
      const ruleKindMatches: Record<LayoutRuleKey, LayoutGroupKind> = {
        'new-editor-tab': 'editor',
        'new-terminal': 'terminal',
        'new-browser-tab': 'browser'
      }
      for (const [ruleKey, groupName] of Object.entries(config.rules)) {
        if (typeof groupName !== 'string') {
          continue
        }
        const group = config.groups[groupName]
        if (!group?.kind || group.kind === 'mixed') {
          continue
        }
        const expected = ruleKindMatches[ruleKey as LayoutRuleKey]
        if (expected && group.kind !== expected) {
          return false
        }
      }
      return true
    },
    {
      message:
        'A rule cannot point at a group whose `kind` rejects that rule (e.g. `new-terminal` → `kind: editor`)'
    }
  )

export type LayoutConfig = z.infer<typeof LayoutConfigSchema>

/**
 * Sentinel main forwards to the renderer when orca.yaml exists but
 * fails YAML parsing (vs "no file" or "no layout block" which are
 * both `null`). Renderer toasts the message instead of treating the
 * worktree as having no layout config.
 */
export type LayoutPushPayload = unknown | null | { __invalidYaml: true; message: string }

export const INVALID_YAML_SENTINEL = '__invalidYaml' as const

export function isInvalidYamlSentinel(
  value: unknown
): value is { __invalidYaml: true; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __invalidYaml?: unknown }).__invalidYaml === true
  )
}

/**
 * Map a content-kind from the Orca renderer (`Tab.contentType`) to the
 * matching `LayoutRuleKey`. Returns null for kinds that don't have a rule
 * (e.g. internal tab types like settings).
 */
export function ruleKeyForContentKind(kind: string): LayoutRuleKey | null {
  switch (kind) {
    case 'editor':
    case 'diff':
    case 'conflict-review':
      return 'new-editor-tab'
    case 'terminal':
      return 'new-terminal'
    case 'browser':
      return 'new-browser-tab'
    default:
      return null
  }
}

/**
 * Bucketing helper for the position-resolution algorithm. See
 * `seedWorktreeLayout` in renderer.
 */
export function classifyPosition(position: LayoutGroupPosition): {
  horizontalSide: 'left' | 'right' | 'center'
  verticalSide: 'top' | 'bottom' | 'center'
} {
  switch (position) {
    case 'left':
      return { horizontalSide: 'left', verticalSide: 'center' }
    case 'right':
      return { horizontalSide: 'right', verticalSide: 'center' }
    case 'top':
      return { horizontalSide: 'center', verticalSide: 'top' }
    case 'bottom':
      return { horizontalSide: 'center', verticalSide: 'bottom' }
    case 'left-top':
      return { horizontalSide: 'left', verticalSide: 'top' }
    case 'left-bottom':
      return { horizontalSide: 'left', verticalSide: 'bottom' }
    case 'right-top':
      return { horizontalSide: 'right', verticalSide: 'top' }
    case 'right-bottom':
      return { horizontalSide: 'right', verticalSide: 'bottom' }
    case 'center':
    default:
      return { horizontalSide: 'center', verticalSide: 'center' }
  }
}
