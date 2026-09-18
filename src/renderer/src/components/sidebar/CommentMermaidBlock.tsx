import React from 'react'
import { ExpandableMermaidDiagram } from '@/components/editor/MermaidDiagramLightbox'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

// Why: comment markdown components are module-level constants without access to
// the live theme, so this wrapper resolves dark mode from the app store (same
// logic the editor uses) and reuses the editor's mermaid renderer. Mermaid HTML
// labels are disabled because MermaidBlock sanitizes the SVG, and sanitized
// foreignObject labels disappear on some platforms.
export default function CommentMermaidBlock({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <ExpandableMermaidDiagram
      content={content}
      isDark={isDark}
      htmlLabels={false}
      className={cn(className)}
    />
  )
}
