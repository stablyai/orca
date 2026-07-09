import React from 'react'
import { ArrowLeft, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'

type WikiPanelTopBarProps = {
  relativePath: string
  canGoBack: boolean
  onBack: () => void
  onHome: () => void
}

// Why: breadcrumb drops the file extension so a note path reads like a title.
function formatWikiBreadcrumb(relativePath: string): string {
  return relativePath.replace(/\.(md|mdx|markdown)$/i, '')
}

export function WikiPanelTopBar({
  relativePath,
  canGoBack,
  onBack,
  onHome
}: WikiPanelTopBarProps): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!canGoBack}
        onClick={onBack}
        aria-label="Back"
        title="Back"
      >
        <ArrowLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!canGoBack}
        onClick={onHome}
        aria-label="Home"
        title="Home"
      >
        <Home />
      </Button>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={relativePath}>
        {formatWikiBreadcrumb(relativePath)}
      </span>
    </div>
  )
}
