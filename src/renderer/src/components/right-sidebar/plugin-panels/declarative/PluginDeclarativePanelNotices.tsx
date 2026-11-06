import React, { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PluginDeclarativeIssue } from './use-plugin-declarative-tree'

/** How long the "Reloaded" mark stays after a dev hot reload. */
export const PLUGIN_DECLARATIVE_RELOADED_NOTICE_MS = 2_000

/**
 * A components panel's issue: a load failure (a broken dev save) is a persistent inline error
 * above the last good tree; anything else is the quiet one-line status it always was.
 */
export function PluginDeclarativeIssueNotice({
  issue,
  title,
  showingLastGood,
  onDismiss
}: {
  issue: PluginDeclarativeIssue
  title: string
  showingLastGood: boolean
  onDismiss: () => void
}): React.JSX.Element {
  if (issue.source === 'load') {
    return (
      <div
        role="alert"
        className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p>
            {showingLastGood
              ? translate(
                  'auto.components.rightSidebar.PluginDeclarativePanel.loadFailedKeptLastGood',
                  '{{value0}} failed to load. Showing the last version that loaded.',
                  { value0: title }
                )
              : translate(
                  'auto.components.rightSidebar.PluginDeclarativePanel.loadFailed',
                  '{{value0}} failed to load.',
                  { value0: title }
                )}
          </p>
          <p className="mt-1 font-mono break-words whitespace-pre-wrap">{issue.message}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={translate(
            'auto.components.rightSidebar.PluginDeclarativePanel.dismissLoadError',
            'Dismiss'
          )}
        >
          <X />
        </Button>
      </div>
    )
  }
  return (
    // Polite and plugin-attributed: this is the plugin's text, not an Orca failure.
    <div
      role="status"
      className="border-b border-border px-3 py-1.5 text-xs break-words text-muted-foreground"
    >
      {issue.source === 'plugin'
        ? translate(
            'auto.components.rightSidebar.PluginDeclarativePanel.pluginMessage',
            'Message from {{value0}}: {{value1}}',
            { value0: title, value1: issue.message }
          )
        : issue.message}
    </div>
  )
}

/** A brief, still (no motion) mark that a dev save reloaded the panel; remount it per reload. */
export function PluginDeclarativeReloadedNotice(): React.JSX.Element | null {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), PLUGIN_DECLARATIVE_RELOADED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div role="status" className="pointer-events-none absolute top-1.5 right-2 z-10">
      {shown ? (
        <span className="rounded-md border border-border bg-background px-1.5 py-0.5 text-2xs text-muted-foreground">
          {translate('auto.components.rightSidebar.PluginDeclarativePanel.reloaded', 'Reloaded')}
        </span>
      ) : null}
    </div>
  )
}
