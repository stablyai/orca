import React from 'react'
import { translate } from '@/i18n/i18n'

/** A diff side past the 10 MB read cap: Orca leaves it unread, so there is nothing to compare. */
export function DiffTooLargeNotice(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">
          {translate('editor.diffTooLarge.title', 'File too large to diff')}
        </div>
        <div className="text-xs text-muted-foreground">
          {translate(
            'editor.diffTooLarge.detail',
            'One version of this file is over 10 MB, so Orca doesn’t load it for a text diff.'
          )}
        </div>
      </div>
    </div>
  )
}
