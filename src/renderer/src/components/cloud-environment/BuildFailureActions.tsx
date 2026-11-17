import type React from 'react'
import { Bot, Github, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/**
 * On the latest failed build, Try again rebuilds. Fix with agent opens a cloud workspace on
 * the last good build with the log attached; Give access opens GitHub when the clone was refused.
 */
export function BuildFailureActions({
  building,
  onTryAgain,
  onFixWithAgent,
  onGiveAccess
}: {
  building: boolean
  onTryAgain: () => void
  /** Null unless what failed is an agent's to fix (install script, repo contents). */
  onFixWithAgent: (() => void) | null
  /** The clone couldn't reach a repo: an agent can't grant access, so this opens GitHub instead. */
  onGiveAccess: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="flex shrink-0 items-center gap-2">
      <Button type="button" variant="outline" size="xs" disabled={building} onClick={onTryAgain}>
        <RotateCcw />
        {t('cloudEnvironment.failure.tryAgain', 'Try again')}
      </Button>
      {onGiveAccess ? (
        <Button type="button" variant="ghost" size="xs" onClick={onGiveAccess}>
          <Github />
          {t('cloudEnvironment.failure.giveAccess', 'Give access')}
        </Button>
      ) : null}
      {onFixWithAgent ? (
        <Button type="button" variant="ghost" size="xs" onClick={onFixWithAgent}>
          <Bot />
          {t('cloudEnvironment.failure.fixWithAgent', 'Fix with agent')}
        </Button>
      ) : null}
    </span>
  )
}
