import React from 'react'
import { ExternalLink, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function GitHubLabelsSettingsLink({
  url,
  separated,
  onOpen
}: {
  url: string | null
  separated?: boolean
  onOpen?: () => void
}): React.JSX.Element | null {
  if (!url) {
    return null
  }

  return (
    <div className={cn(separated && 'mt-1 border-t border-border/60 pt-1')}>
      <button
        type="button"
        onClick={() => {
          onOpen?.()
          void window.api.shell.openUrl(url)
        }}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Settings className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-left">
          {translate('auto.components.GitHubItemDialog.2aa9acdf34', 'Edit labels on GitHub')}
        </span>
        <ExternalLink className="size-3 shrink-0 opacity-70" />
      </button>
    </div>
  )
}
