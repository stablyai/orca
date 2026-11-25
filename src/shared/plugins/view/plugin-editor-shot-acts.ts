import { z } from 'zod'
import { PLUGIN_SHOT_MAX_ACTS } from './plugin-shot-acts'

/**
 * `orca plugin shot --editor --act`: real input sent to the editor's frame before the capture, in
 * the editor's CSS pixels from its top-left corner: `{"click":[x,y]}`, `{"drag":[[x1,y1],[x2,y2]]}`
 * and `{"key":"r"}` (a key name such as `Enter`, with optional `modifiers`).
 */

// Why a cap: well past any editor size, and keeps a typo from aiming input far off screen.
const MAX_COORDINATE = 10_000
const KEY_MODIFIERS = ['shift', 'control', 'alt', 'meta'] as const

const coordinate = z.number().finite().min(0).max(MAX_COORDINATE)
const point = z.tuple([coordinate, coordinate])

const EDITOR_ACT_SCHEMAS = {
  click: z.strictObject({ click: point }),
  drag: z.strictObject({ drag: z.tuple([point, point]) }),
  key: z.strictObject({
    key: z.string().min(1).max(32),
    modifiers: z.array(z.enum(KEY_MODIFIERS)).max(KEY_MODIFIERS.length).optional()
  })
}

export const pluginEditorShotActSchema = z.union([
  EDITOR_ACT_SCHEMAS.click,
  EDITOR_ACT_SCHEMAS.drag,
  EDITOR_ACT_SCHEMAS.key
])
export type PluginEditorShotAct = z.infer<typeof pluginEditorShotActSchema>

export const pluginEditorShotActsSchema = z
  .array(pluginEditorShotActSchema)
  .min(1)
  .max(PLUGIN_SHOT_MAX_ACTS)

const VERBS = ['click', 'drag', 'key'] as const

function issueOf(index: number, value: unknown): string {
  const where = `action ${index + 1}`
  const verb =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? VERBS.find((name) => name in value)
      : undefined
  if (!verb) {
    return `${where}: expected an object with one of ${VERBS.join(', ')}`
  }
  const parsed = EDITOR_ACT_SCHEMAS[verb].safeParse(value)
  const first = parsed.success ? undefined : parsed.error.issues[0]
  const path = first?.path.length ? ` (${first.path.join('.')})` : ''
  return `${where} (${verb})${path}: ${first?.message ?? 'invalid'}`
}

/** `--act`'s JSON for an editor shot, checked here so a typo fails before Orca opens anything. */
export function parsePluginEditorShotActs(
  json: string
): { ok: true; acts: PluginEditorShotAct[] } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : 'invalid'}` }
  }
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0 || list.length > PLUGIN_SHOT_MAX_ACTS) {
    return { ok: false, error: `pass 1 to ${PLUGIN_SHOT_MAX_ACTS} actions` }
  }
  const acts: PluginEditorShotAct[] = []
  for (const [index, entry] of list.entries()) {
    const parsed = pluginEditorShotActSchema.safeParse(entry)
    if (!parsed.success) {
      return { ok: false, error: issueOf(index, entry) }
    }
    acts.push(parsed.data)
  }
  return { ok: true, acts }
}

type InputModifier = (typeof KEY_MODIFIERS)[number] | 'leftbuttondown'

/** The subset of Electron's `InputEvent` these acts send through `webContents.sendInputEvent`. */
export type PluginEditorInputEvent =
  | {
      type: 'mouseMove' | 'mouseDown' | 'mouseUp'
      x: number
      y: number
      button?: 'left'
      clickCount?: number
      modifiers?: InputModifier[]
    }
  | { type: 'keyDown' | 'char' | 'keyUp'; keyCode: string; modifiers?: InputModifier[] }

// Why steps: editors such as canvases draw a drag from the moves between press and release.
const DRAG_STEPS = 8

/** The input events for one act. `origin` is where the editor's (0,0) lands in the target's
 *  coordinates and `scale` its zoom, so the same act works on a guest or the window's page. */
export function pluginEditorActInputEvents(
  act: PluginEditorShotAct,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  scale = 1
): PluginEditorInputEvent[] {
  const at = ([x, y]: readonly [number, number]) => ({
    x: Math.round((origin.x + x) * scale),
    y: Math.round((origin.y + y) * scale)
  })
  if ('click' in act) {
    const p = at(act.click)
    return [
      { type: 'mouseMove', ...p },
      { type: 'mouseDown', ...p, button: 'left', clickCount: 1 },
      { type: 'mouseUp', ...p, button: 'left', clickCount: 1 }
    ]
  }
  if ('drag' in act) {
    const [[x1, y1], [x2, y2]] = act.drag
    const moves = Array.from({ length: DRAG_STEPS }, (_, index) => {
      const t = (index + 1) / DRAG_STEPS
      return {
        type: 'mouseMove' as const,
        ...at([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]),
        // Why: Chromium reads a held button from the modifiers, not from the press before.
        modifiers: ['leftbuttondown' as const]
      }
    })
    return [
      { type: 'mouseMove', ...at([x1, y1]) },
      { type: 'mouseDown', ...at([x1, y1]), button: 'left', clickCount: 1 },
      ...moves,
      { type: 'mouseUp', ...at([x2, y2]), button: 'left', clickCount: 1 }
    ]
  }
  const modifiers = act.modifiers?.length ? { modifiers: [...act.modifiers] } : {}
  // Only a printable key without a command modifier types a character.
  const types =
    [...act.key].length === 1 && !act.modifiers?.some((modifier) => modifier !== 'shift')
  return [
    { type: 'keyDown', keyCode: act.key, ...modifiers },
    ...(types ? [{ type: 'char' as const, keyCode: act.key, ...modifiers }] : []),
    { type: 'keyUp', keyCode: act.key, ...modifiers }
  ]
}
