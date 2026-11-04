// Upstream packaging bug: @xterm/addon-ligatures declares a missing module
// entry. config/patches/@xterm__addon-ligatures* keeps the runtime import valid.
import { LigaturesAddon } from '@xterm/addon-ligatures'
import type { Terminal } from '@xterm/xterm'
import { isLigatureFontWithinBudget } from './ligature-font-budget'

export type LigatureRange = [number, number]
type CharacterJoiner = (text: string) => LigatureRange[]
type LocalFontFace = { family: string; blob: () => Promise<Blob> }

// Matches the addon's stop list: past a generic family the rendered face is unknowable.
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'cursive',
  'fantasy',
  'monospace',
  'system-ui',
  'emoji',
  'math',
  'fangsong'
])

let firstFaceByFamilyPromise: Promise<Map<string, LocalFontFace>> | null = null

/** One query per session, keeping the addon's first-face-per-family choice. */
function queryFirstFaceByFamily(): Promise<Map<string, LocalFontFace>> {
  firstFaceByFamilyPromise ??= (async () => {
    const faces = new Map<string, LocalFontFace>()
    try {
      for (const face of (await window.queryLocalFonts?.()) ?? []) {
        if (!faces.has(face.family)) {
          faces.set(face.family, face)
        }
      }
    } catch {
      // Denied or unsupported font access leaves the addon's fallback ligatures.
    }
    return faces
  })()
  return firstFaceByFamilyPromise
}

/** Orca stacks are buildFontFamily output: comma-separated, quoted names without escapes. */
function resolveInstalledFace(
  fontFamily: string,
  faces: Map<string, LocalFontFace>
): LocalFontFace | null {
  for (const part of fontFamily.split(',')) {
    const family = part.trim().replace(/^(["'])(.*)\1$/, '$2')
    if (GENERIC_FONT_FAMILIES.has(family)) {
      return null
    }
    const face = faces.get(family)
    if (face) {
      return face
    }
  }
  return null
}

/** The addon's CSS parser drops a trailing quoted family, so end the list with a generic one. */
function toSingleFamilyStack(family: string): string {
  return `"${family.replace(/["\\]/g, '\\$&')}", monospace`
}

/**
 * One parsed font per CSS font stack, shared by every terminal using it. The addon otherwise
 * reads and parses the whole font file once per terminal, which OOMed renderers on restore.
 */
class SharedLigatureFont {
  private readonly listeners = new Set<() => void>()
  // The addon reads only fontFamily; leaving it unset keeps the addon on its fallback ligature list.
  private readonly delegateOptions: { fontFamily?: string } = {}
  private readonly addon = new LigaturesAddon()
  private joiner: CharacterJoiner | null = null
  private disposed = false
  refCount = 0

  constructor(readonly fontFamily: string) {
    const delegate = {
      element: { style: {} },
      options: this.delegateOptions,
      rows: 0,
      registerCharacterJoiner: (joiner: CharacterJoiner): number => {
        this.joiner = joiner
        return 1
      },
      deregisterCharacterJoiner: (): void => {
        this.joiner = null
      },
      // The addon refreshes its terminal once the parsed font is ready.
      refresh: (): void => {
        for (const listener of this.listeners) {
          listener()
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addon reads only element, options, rows, refresh and (de)registerCharacterJoiner, all provided.
    this.addon.activate(delegate as unknown as Terminal)
    void this.enableFontLigatures()
  }

  private async enableFontLigatures(): Promise<void> {
    const face = resolveInstalledFace(this.fontFamily, await queryFirstFaceByFamily())
    if (!face || this.disposed) {
      return
    }
    let withinBudget = false
    try {
      withinBudget = isLigatureFontWithinBudget(await (await face.blob()).arrayBuffer())
    } catch {
      // Unreadable font data stays on fallback ligatures.
    }
    if (this.disposed) {
      return
    }
    if (!withinBudget) {
      console.warn(
        `[terminal] "${face.family}" ligature rules are too large to parse; using common ligatures`
      )
      return
    }
    // Pass only the checked family so the addon parses the face that passed the budget.
    this.delegateOptions.fontFamily = toSingleFamilyStack(face.family)
    // The addon starts loading on its next join.
    this.joiner?.('')
  }

  join(text: string): LigatureRange[] {
    return this.joiner?.(text) ?? []
  }

  onFontLoaded(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.addon.dispose()
  }
}

export type { SharedLigatureFont }

const sharedFonts = new Map<string, SharedLigatureFont>()

export function acquireSharedLigatureFont(fontFamily: string): SharedLigatureFont {
  let font = sharedFonts.get(fontFamily)
  if (!font) {
    font = new SharedLigatureFont(fontFamily)
    sharedFonts.set(fontFamily, font)
  }
  font.refCount++
  return font
}

/** Drop the parsed font once no terminal uses it so font switches do not accumulate parses. */
export function releaseSharedLigatureFont(font: SharedLigatureFont): void {
  font.refCount--
  if (font.refCount > 0 || sharedFonts.get(font.fontFamily) !== font) {
    return
  }
  sharedFonts.delete(font.fontFamily)
  font.dispose()
}
