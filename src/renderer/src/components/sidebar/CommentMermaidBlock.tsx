import React from 'react'
import MermaidBlock from '@/components/editor/MermaidBlock'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

// Why: comment markdown components are module-level constants without access to
// the live theme, so this wrapper resolves dark mode from the app store (same
// logic the editor uses) and reuses the editor's MermaidBlock renderer. Mermaid
// HTML labels are disabled because MermaidBlock sanitizes the SVG, and sanitized
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
    <div className={cn(className)}>
      <MermaidBlock content={content} isDark={isDark} htmlLabels={false} />
    </div>
  )
}
