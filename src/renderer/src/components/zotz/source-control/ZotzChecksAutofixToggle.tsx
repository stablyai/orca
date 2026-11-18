import React from 'react'
import { SwitchIndicator } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { setZotzPrAutofix, useZotzPrAutofix } from './zotz-pr-autofix-store'

/** Checks panel switch: once per push, failing checks go to the conversation's agent on their own. */
export function ZotzChecksAutofixToggle({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const t = useTranslate()
  const { enabled } = useZotzPrAutofix(worktreeId)
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => setZotzPrAutofix(worktreeId, !enabled)}
        className="group flex items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <SwitchIndicator checked={enabled} size="compact" />
        <span className="text-muted-foreground transition-colors group-hover:text-foreground">
          {t('zotz.prChecks.autofix', 'Autofix')}
        </span>
      </button>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {t('zotz.prChecks.autofixHint', 'Sends failing checks to the agent once per push')}
      </span>
    </div>
  )
}
