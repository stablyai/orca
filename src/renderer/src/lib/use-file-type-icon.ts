import type React from 'react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '@/store'
import { getFileTypeIcon } from './file-type-icons'
import { getSymbolsFileTypeIcon } from './file-type-icons-symbols'

export type FileIconTheme = 'lucide' | 'symbols'

export function resolveFileTypeIcon(
  filePath: string | undefined | null,
  theme: FileIconTheme,
): LucideIcon | React.ComponentType<{ className?: string }> {
  return theme === 'symbols' ? getSymbolsFileTypeIcon(filePath) : getFileTypeIcon(filePath)
}

export function useFileTypeIcon(
  filePath: string | undefined | null,
): LucideIcon | React.ComponentType<{ className?: string }> {
  const theme = useAppStore((s) => s.settings?.fileIconTheme ?? 'lucide')
  return resolveFileTypeIcon(filePath, theme)
}

export function useFileIconTheme(): FileIconTheme {
  return useAppStore((s) => s.settings?.fileIconTheme ?? 'lucide')
}
