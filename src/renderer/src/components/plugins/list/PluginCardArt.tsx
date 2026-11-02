import { Cpu, File, FileCode, FileJson, FileText, Folder, Image, Puzzle } from 'lucide-react'
import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import { formatKeybinding } from '../../../../../shared/keybindings/formatting'

/** Colours a theme plugin paints with, read from its live registration or its catalog entry. */
export type PluginArtPalette = {
  background: string
  foreground: string
  accent: string
  muted: string
}

const isMac = (): boolean => navigator.userAgent.includes('Mac')

// Why these tokens: they already paint accents in both themes, so art needs no new colours.
const ART_INKS = [
  'var(--callout-note)',
  'var(--callout-important)',
  'var(--status-success)',
  'var(--status-warning)',
  'var(--destructive)',
  'var(--chart-3)'
] as const
const ART_TINTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const

function hashKey(key: string): number {
  let hash = 0
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash
}

// Why two: a theme pair shows its dark and light palettes side by side.
const THEME_ART_SLOTS = ['first', 'second'] as const

function ThemeArt({ palettes }: { palettes: readonly PluginArtPalette[] }): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex">
      {THEME_ART_SLOTS.flatMap((slot, index) => {
        const palette = palettes[index]
        return palette ? [{ slot, palette }] : []
      }).map(({ slot, palette }) => (
        // Why inline colour: these are the plugin's own theme values, painted as its picture.
        <div
          key={slot}
          className="relative flex-1 overflow-hidden"
          style={{ background: palette.background }}
        >
          <div
            className="absolute inset-x-[14%] top-[18%] bottom-[18%] rounded-md p-[8%]"
            style={{ background: palette.muted }}
          >
            {[0.7, 0.45, 0.6, 0.35].map((width, line) => (
              <div
                key={line}
                className="mb-[9%] h-1.5 rounded-full"
                style={{
                  width: `${width * 100}%`,
                  marginLeft: line % 2 ? '14%' : 0,
                  background: line === 1 ? palette.accent : palette.foreground,
                  opacity: line === 1 ? 1 : 0.55
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function SyntaxArt({ fileType }: { fileType: string | null }): React.JSX.Element {
  const widths = [62, 40, 74, 28, 54]
  return (
    <div className="absolute inset-[14%] overflow-hidden rounded-md border border-border bg-background shadow-xs">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 font-mono text-3xs text-muted-foreground">
        <FileCode className="size-3" />
        {fileType}
      </div>
      <div className="space-y-1.5 px-2.5 py-2">
        {widths.map((width, line) => (
          <div key={line} className="flex gap-1.5" style={{ paddingLeft: line % 3 ? 12 : 0 }}>
            <span
              className="h-1.5 w-5 rounded-full"
              style={{ background: ART_INKS[line % 2 === 0 ? 1 : 0] }}
            />
            <span
              className="h-1.5 rounded-full"
              style={{
                width: `${width}%`,
                background:
                  line === 2
                    ? ART_INKS[2]
                    : 'color-mix(in srgb, var(--foreground) 20%, transparent)'
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function IconThemeArt(): React.JSX.Element {
  const glyphs = [
    { name: 'folder', Glyph: Folder },
    { name: 'code', Glyph: FileCode },
    { name: 'json', Glyph: FileJson },
    { name: 'text', Glyph: FileText },
    { name: 'image', Glyph: Image },
    { name: 'file', Glyph: File }
  ]
  return (
    <div className="absolute inset-0 grid grid-cols-3 place-content-center place-items-center gap-3 px-[22%]">
      {glyphs.map(({ name, Glyph }, index) => (
        <span
          key={name}
          className="flex size-9 items-center justify-center rounded-lg border border-border bg-background shadow-xs"
        >
          <Glyph className="size-4" style={{ color: ART_INKS[index % ART_INKS.length] }} />
        </span>
      ))}
    </div>
  )
}

function KeycapArt({ shortcut }: { shortcut: string | null }): React.JSX.Element {
  const platform: NodeJS.Platform = isMac()
    ? 'darwin'
    : navigator.userAgent.includes('Windows')
      ? 'win32'
      : 'linux'
  // Why modifiers only without a shortcut: a made-up letter would read as a real binding.
  const keys = shortcut
    ? formatKeybinding(shortcut, platform)
    : isMac()
      ? ['⌘', '⌥', '⇧']
      : ['Ctrl', 'Alt', '⇧']
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-2.5">
      {keys.map((key, index) => (
        <span
          key={`${key}-${index}`}
          className="flex h-16 min-w-16 items-center justify-center rounded-xl border border-border border-b-4 bg-background px-3 text-2xl font-medium text-foreground shadow-xs"
        >
          {key}
        </span>
      ))}
    </div>
  )
}

function PanelArt({ worker }: { worker: boolean }): React.JSX.Element {
  return (
    <div className="absolute inset-x-[16%] top-[16%] bottom-0 flex gap-2 rounded-t-lg border border-b-0 border-border bg-background p-2.5 shadow-xs">
      {[3, 2, 3].map((rows, column) => (
        <div key={column} className="flex flex-1 flex-col gap-1.5">
          <span className="h-1.5 w-1/2 rounded-full bg-foreground/30" />
          {Array.from({ length: rows }, (_, row) => (
            <span key={row} className="h-5 rounded border border-border bg-muted" />
          ))}
        </div>
      ))}
      {worker ? <Cpu className="absolute right-2 bottom-2 size-4 text-muted-foreground" /> : null}
    </div>
  )
}

const OUTLINE_WIDTHS = [0.7, 0.45, 0.6, 0.35] as const

/** Seeded look for drawn art, so two plugins without pictures never share one. */
type ArtSeed = { tint: string; ink: string; widths: readonly number[]; mirrored: boolean }

function artSeed(key: string): ArtSeed {
  const hash = hashKey(key)
  const tintCount = ART_TINTS.length
  const inkCount = ART_INKS.length
  const shift = Math.floor(hash / (tintCount * inkCount)) % OUTLINE_WIDTHS.length
  return {
    tint: ART_TINTS[hash % tintCount] ?? ART_TINTS[0],
    ink: ART_INKS[Math.floor(hash / tintCount) % inkCount] ?? ART_INKS[0],
    widths: [...OUTLINE_WIDTHS.slice(shift), ...OUTLINE_WIDTHS.slice(0, shift)].slice(0, 3),
    mirrored: Math.floor(hash / (tintCount * inkCount * OUTLINE_WIDTHS.length)) % 2 === 1
  }
}

function OutlineLines({ inverted, seed }: { inverted: boolean; seed: ArtSeed }): React.JSX.Element {
  return (
    <>
      {seed.widths.map((width, line) => (
        <div
          key={line}
          data-inverted={inverted}
          className="mb-[12%] h-1.5 rounded-full bg-foreground/35 data-[inverted=true]:bg-background/45"
          style={{
            width: `${width * 100}%`,
            ...(line === 1 ? { background: seed.ink } : {})
          }}
        />
      ))}
    </>
  )
}

/** A theme with no colours known yet: one window in the app's light and dark ink, seeded per plugin. */
function ThemeOutlineArt({ seed }: { seed: ArtSeed }): React.JSX.Element {
  return (
    <div
      data-mirrored={seed.mirrored}
      className="absolute inset-0 flex items-center justify-center gap-3 px-[12%] data-[mirrored=true]:flex-row-reverse"
    >
      <div className="h-[62%] flex-1 rounded-md border border-border bg-background p-[6%] shadow-xs">
        <OutlineLines inverted={false} seed={seed} />
      </div>
      <div className="h-[62%] flex-1 rounded-md border border-border bg-foreground p-[6%] shadow-xs">
        <OutlineLines inverted seed={seed} />
      </div>
    </div>
  )
}

function LanguageArt(): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 text-2xl font-medium text-muted-foreground">
      <span>Ä</span>
      <span>文</span>
      <span>あ</span>
      <span>Ж</span>
    </div>
  )
}

/**
 * The 16:10 picture on a plugin's card and page. Until plugins ship images, it is drawn from what
 * the plugin is: its theme colours, a code sample, keycaps. A plugin glyph is the last resort.
 */
export function PluginCardArt({
  types,
  fileType,
  palettes,
  tintKey,
  shortcut = null,
  fill = false
}: {
  types: readonly PluginCatalogType[]
  fileType: string | null
  palettes: readonly PluginArtPalette[]
  /** The plugin's first shortcut, so keycap art shows its own keys. */
  shortcut?: string | null
  /** Fill a sized parent (the page hero) instead of setting its own 16:10 height. */
  fill?: boolean
  /** Seeds the backdrop tint and drawn details, so each plugin's art is its own everywhere. */
  tintKey: string
}): React.JSX.Element {
  const seed = artSeed(tintKey)
  let art: React.ReactNode
  if (palettes.length > 0) {
    art = <ThemeArt palettes={palettes} />
  } else if (types.includes('panel') || types.includes('editor') || types.includes('worker')) {
    art = <PanelArt worker={types.includes('worker')} />
  } else if (types.includes('syntax')) {
    art = <SyntaxArt fileType={fileType} />
  } else if (types.includes('icon-theme')) {
    art = <IconThemeArt />
  } else if (types.includes('instructions')) {
    art = <KeycapArt shortcut={shortcut} />
  } else if (types.includes('interface-language')) {
    art = <LanguageArt />
  } else if (types.includes('app-theme') || types.includes('terminal-theme')) {
    art = <ThemeOutlineArt seed={seed} />
  } else {
    // Why a glyph, not initials: letters on a blank tile read as an empty listing.
    art = (
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-16 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground shadow-xs">
          <Puzzle className="size-7" style={{ color: seed.ink }} />
        </span>
      </div>
    )
  }
  return (
    <div
      aria-hidden="true"
      data-fill={fill}
      className="relative aspect-[16/10] overflow-hidden data-[fill=true]:absolute data-[fill=true]:inset-0 data-[fill=true]:aspect-auto bg-[radial-gradient(color-mix(in_srgb,var(--foreground)_9%,transparent)_1px,transparent_1.2px)] bg-size-[14px_14px]"
      style={{ backgroundColor: `color-mix(in srgb, var(${seed.tint}) 16%, var(--muted))` }}
    >
      {art}
    </div>
  )
}
