import React, { useMemo, useState } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import { buildFileExplorerCssVars } from '@/hooks/useFileExplorerCssVars'
import {
  DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK,
  getFileExplorerColorTheme,
  toColorMap
} from '@/lib/file-explorer-themes'
import { resolveIconWithFallback } from '@/lib/icon-themes'
import { getIconTheme } from '@/lib/icon-themes/index'
import { cn } from '@/lib/utils'

type FileExplorerPreviewProps = {
  iconThemeId: string
  iconSize: number
}

const ICON_STYLE: React.CSSProperties = {
  width: 'var(--fe-icon-size)',
  height: 'var(--fe-icon-size)'
}

type PreviewRow = {
  name: string
  depth: number
  isDirectory: boolean
  expanded?: boolean
}

const PREVIEW_ROWS: readonly PreviewRow[] = [
  { name: 'src', depth: 0, isDirectory: true, expanded: true },
  { name: 'components', depth: 1, isDirectory: true, expanded: false },
  { name: 'App.tsx', depth: 1, isDirectory: false },
  { name: 'styles.css', depth: 1, isDirectory: false },
  { name: 'package.json', depth: 0, isDirectory: false },
  { name: '.env', depth: 0, isDirectory: false },
  { name: 'README.md', depth: 0, isDirectory: false }
]

export function FileExplorerPreview({
  iconThemeId,
  iconSize
}: FileExplorerPreviewProps): React.JSX.Element {
  const [selected, setSelected] = useState<string>('package.json')
  const [hover, setHover] = useState<string | null>(null)

  const colorTheme = useMemo(
    () => getFileExplorerColorTheme(DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK)!,
    []
  )

  const cssVars = useMemo(
    () => ({
      ...buildFileExplorerCssVars(toColorMap(colorTheme)),
      '--fe-icon-size': `${iconSize}px`,
      '--fe-text-size': `${iconSize - 4}px`
    }),
    [colorTheme, iconSize]
  )

  const iconTheme = getIconTheme(iconThemeId)
  const monochrome = iconTheme?.monochrome ?? true

  return (
    <div
      className="rounded-md border border-border/50 p-2 text-[length:var(--fe-text-size,12px)]"
      style={{ ...cssVars, backgroundColor: 'var(--fe-bg)' }}
    >
      <div className="space-y-px">
        {PREVIEW_ROWS.map((row) => {
          const isSelected = selected === row.name
          const isHover = hover === row.name && !isSelected
          const Icon = resolveIconWithFallback(
            iconThemeId,
            row.name,
            row.isDirectory,
            row.expanded ?? false
          )
          return (
            <button
              key={row.name}
              type="button"
              onClick={() => setSelected(row.name)}
              onMouseEnter={() => setHover(row.name)}
              onMouseLeave={() => setHover(null)}
              className={cn(
                'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left transition-colors',
                'text-[var(--fe-text)]'
              )}
              style={{
                paddingLeft: `${row.depth * 16 + 8}px`,
                backgroundColor: isSelected
                  ? 'var(--fe-bg-selected)'
                  : isHover
                    ? 'var(--fe-bg-hover)'
                    : 'transparent',
                color: isSelected ? 'var(--fe-text-selected)' : 'var(--fe-text)'
              }}
            >
              {row.isDirectory ? (
                <>
                  <ChevronRight
                    className={cn(
                      'shrink-0 text-[var(--fe-icon-folder)] transition-transform',
                      row.expanded && 'rotate-90'
                    )}
                    style={ICON_STYLE}
                  />
                  <Icon
                    className={cn('shrink-0', monochrome && 'text-[var(--fe-icon-folder)]')}
                    style={ICON_STYLE}
                  />
                </>
              ) : (
                <>
                  <span className="shrink-0" style={ICON_STYLE} />
                  <Icon
                    className={cn('shrink-0', monochrome && 'text-[var(--fe-icon-file)]')}
                    style={ICON_STYLE}
                  />
                </>
              )}
              <span className="truncate">{row.name}</span>
            </button>
          )
        })}
        <button
          type="button"
          disabled
          className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left italic"
          style={{ paddingLeft: '8px', color: 'var(--fe-text-ignored)' }}
        >
          <span className="shrink-0" style={ICON_STYLE} />
          <Folder
            className={cn('shrink-0', monochrome && 'text-[var(--fe-text-ignored)]')}
            style={ICON_STYLE}
          />
          <span className="truncate">node_modules (ignored)</span>
        </button>
      </div>
    </div>
  )
}
