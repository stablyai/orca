import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { MaterialFileIcons } from '@/lib/material-file-icons'

type IconThemeContextValue = {
  /** Loaded Material icon lookups, or null while the default theme is active. */
  material: MaterialFileIcons | null
}

const IconThemeContext = createContext<IconThemeContextValue>({ material: null })

// Why: one store subscription for the whole right sidebar instead of one per
// file row; rows read the resolved value from context.
export function IconThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const vscodeIcons = useAppStore((s) => s.settings?.iconTheme === 'vscode')
  const [material, setMaterial] = useState<MaterialFileIcons | null>(null)

  useEffect(() => {
    if (!vscodeIcons || material) {
      return
    }
    let cancelled = false
    import('@/lib/material-file-icons')
      .then((mod) => {
        if (!cancelled) {
          setMaterial(mod)
        }
      })
      .catch((error: unknown) => {
        // Why: a missing icon chunk must never break the file lists; rows keep
        // rendering the default lucide icons.
        console.warn('[icon-theme] failed to load Material icons', error)
      })
    return () => {
      cancelled = true
    }
  }, [vscodeIcons, material])

  const value = useMemo(
    () => ({ material: vscodeIcons ? material : null }),
    [vscodeIcons, material]
  )
  return <IconThemeContext.Provider value={value}>{children}</IconThemeContext.Provider>
}

type ThemedIconProps = {
  name: string
  className?: string
  /** Rendered for the default theme and while Material icons are loading. */
  fallback: React.ReactNode
}

function MaterialImg({ url, className }: { url: string; className?: string }): React.JSX.Element {
  return <img src={url} alt="" aria-hidden draggable={false} className={className} />
}

export function ThemedFileIcon({ name, className, fallback }: ThemedIconProps): React.JSX.Element {
  const { material } = useContext(IconThemeContext)
  const url = material?.getMaterialFileIconUrl(name)
  return url ? <MaterialImg url={url} className={className} /> : <>{fallback}</>
}

export function ThemedFolderIcon({
  name,
  open,
  className,
  fallback
}: ThemedIconProps & { open: boolean }): React.JSX.Element {
  const { material } = useContext(IconThemeContext)
  const url = material?.getMaterialFolderIconUrl(name, open)
  return url ? <MaterialImg url={url} className={className} /> : <>{fallback}</>
}
