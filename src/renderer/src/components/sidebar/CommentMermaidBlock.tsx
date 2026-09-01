import React from 'react'
import MermaidBlock from '@/components/editor/MermaidBlock'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { resolveDocumentTheme } from '@/lib/document-theme'
import {
  resolveAppAppearanceDarkMode,
  type AppAppearanceSettings
} from '@/lib/left-sidebar-appearance'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

export type CommentMermaidScheme = 'app' | 'editor'

export function resolveCommentMermaidDarkMode(
  settings: AppAppearanceSettings | null | undefined,
  systemPrefersDark: boolean,
  scheme: CommentMermaidScheme = 'app'
): boolean {
  const baseDark = resolveDocumentTheme(settings?.theme ?? 'system', () => ({
    matches: systemPrefersDark
  }))
  if (scheme === 'editor') {
    return baseDark
  }
  return resolveAppAppearanceDarkMode(settings, systemPrefersDark) ?? baseDark
}

// Why: comment markdown components are module-level constants without access to
// the live theme, so this wrapper resolves dark mode from the app store (same
// logic the editor uses) and reuses the editor's MermaidBlock renderer. Mermaid
// HTML labels are disabled because MermaidBlock sanitizes the SVG, and sanitized
// foreignObject labels disappear on some platforms.
export default function CommentMermaidBlock({
  content,
  className,
  scheme = 'app'
}: {
  content: string
  className?: string
  scheme?: CommentMermaidScheme
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const isDark = resolveCommentMermaidDarkMode(settings, systemPrefersDark, scheme)

  return (
    <div className={cn(className)}>
      <MermaidBlock content={content} isDark={isDark} htmlLabels={false} />
    </div>
  )
}
