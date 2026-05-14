import { canonicalChordsEqual, eventToCanonicalChord, parseCanonicalChord } from './chord-parser'
import type {
  EffectiveKeybinding,
  EffectiveKeymap,
  CanonicalChord,
  KeybindingCatalogEntry,
  KeybindingDiagnostic,
  KeybindingEvent,
  KeybindingPlatform,
  ShortcutSurface,
  UserKeybindingOverrides
} from './keybinding-types'

export type BuildEffectiveKeymapInput = {
  catalog: KeybindingCatalogEntry[]
  platform: KeybindingPlatform
  overrides?: UserKeybindingOverrides
}

export function buildEffectiveKeymap({
  catalog,
  platform,
  overrides = {}
}: BuildEffectiveKeymapInput): EffectiveKeymap {
  const diagnostics: KeybindingDiagnostic[] = []
  const entriesById = new Map(catalog.map((entry) => [entry.id, entry]))
  let bindings: EffectiveKeybinding[] = []

  for (const [actionId] of Object.entries(overrides)) {
    if (!entriesById.has(actionId as never)) {
      diagnostics.push({
        code: 'unknown-action',
        actionId,
        message: `Unknown keybinding action: ${actionId}`
      })
    }
  }

  for (const entry of catalog) {
    const override = overrides[entry.id]
    const resolved = resolveChordSet(entry, platform, override, diagnostics)
    bindings.push({
      id: entry.id,
      title: entry.title,
      surfaces: entry.surfaces,
      chords: resolved.chords,
      command: entry.command,
      source: resolved.source,
      allowRepeat: entry.allowRepeat ?? false
    })
  }

  bindings = ignoreConflictingUserOverrides({ catalog, bindings, platform, diagnostics })

  return { platform, bindings, diagnostics }
}

export function resolveKeybindingAction(
  keymap: EffectiveKeymap,
  event: KeybindingEvent,
  surface: ShortcutSurface
): Pick<EffectiveKeybinding, 'id' | 'command'> | null {
  const eventChord = eventToCanonicalChord(event)
  for (const binding of keymap.bindings) {
    if (!binding.surfaces.includes(surface)) {
      continue
    }
    if (event.repeat && !binding.allowRepeat) {
      continue
    }
    if (binding.chords.some((chord) => canonicalChordsEqual(chord, eventChord))) {
      return { id: binding.id, command: binding.command }
    }
  }
  return null
}

function resolveChordSet(
  entry: KeybindingCatalogEntry,
  platform: KeybindingPlatform,
  override: UserKeybindingOverrides[string] | undefined,
  diagnostics: KeybindingDiagnostic[]
): Pick<EffectiveKeybinding, 'chords' | 'source'> {
  if (override === 'none') {
    return { chords: [], source: 'unbound' }
  }

  if (override != null) {
    const rawChords = Array.isArray(override) ? override : [override]
    const chords: CanonicalChord[] = []
    for (const rawChord of rawChords) {
      if (typeof rawChord !== 'string' || rawChord.trim() === '') {
        diagnostics.push({
          code: 'invalid-value',
          actionId: entry.id,
          message: `Invalid keybinding value for ${entry.id}`
        })
        continue
      }
      try {
        chords.push(parseCanonicalChord(rawChord))
      } catch (error) {
        diagnostics.push({
          code: 'invalid-chord',
          actionId: entry.id,
          chord: rawChord,
          message: error instanceof Error ? error.message : `Invalid chord: ${rawChord}`
        })
      }
    }
    return { chords, source: 'user' }
  }

  return {
    chords: (entry.defaults[platform] ?? []).map((chord) => parseCanonicalChord(chord)),
    source: 'default'
  }
}

function ignoreConflictingUserOverrides({
  catalog,
  bindings,
  platform,
  diagnostics
}: {
  catalog: KeybindingCatalogEntry[]
  bindings: EffectiveKeybinding[]
  platform: KeybindingPlatform
  diagnostics: KeybindingDiagnostic[]
}): EffectiveKeybinding[] {
  const conflictedActionIds = new Set<string>()

  for (const binding of bindings) {
    if (binding.source !== 'user') {
      continue
    }
    for (const chord of binding.chords) {
      const conflict = bindings.find(
        (candidate) =>
          candidate.id !== binding.id &&
          candidate.chords.some((candidateChord) => canonicalChordsEqual(candidateChord, chord)) &&
          shortcutSurfacesOverlap(binding.surfaces, candidate.surfaces)
      )
      if (!conflict) {
        continue
      }
      diagnostics.push({
        code: 'conflict',
        actionId: binding.id,
        chord: serializeConflictChord(chord),
        message: `${binding.id} conflicts with ${conflict.id}`
      })
      conflictedActionIds.add(binding.id)
    }
  }

  if (conflictedActionIds.size === 0) {
    return bindings
  }

  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]))
  return bindings.map((binding) => {
    if (!conflictedActionIds.has(binding.id)) {
      return binding
    }
    const entry = catalogById.get(binding.id)
    if (!entry) {
      return binding
    }
    return {
      ...binding,
      chords: (entry.defaults[platform] ?? []).map((chord) => parseCanonicalChord(chord)),
      source: 'default'
    }
  })
}

export function shortcutSurfacesOverlap(
  left: ShortcutSurface[],
  right: ShortcutSurface[]
): boolean {
  return left.some((leftSurface) =>
    right.some((rightSurface) => singleSurfacesOverlap(leftSurface, rightSurface))
  )
}

function singleSurfacesOverlap(left: ShortcutSurface, right: ShortcutSurface): boolean {
  if (left === right) {
    return true
  }
  if (left === 'mainWindow' || right === 'mainWindow') {
    return true
  }
  if (left === 'menu' || right === 'menu') {
    return false
  }
  return (
    (left === 'terminal' && right === 'terminalClipboardBypass') ||
    (left === 'terminalClipboardBypass' && right === 'terminal')
  )
}

function serializeConflictChord(chord: CanonicalChord): string {
  const parts: string[] = []
  if (chord.cmd) {
    parts.push('cmd')
  }
  if (chord.ctrl) {
    parts.push('ctrl')
  }
  if (chord.alt) {
    parts.push('alt')
  }
  if (chord.shift) {
    parts.push('shift')
  }
  parts.push(chord.key)
  return parts.join('+')
}
