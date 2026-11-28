import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { BundledSkillInstallActionState } from '@/hooks/skills/installation/use-bundled-skill-install-action'
import { bundledSkillReplaceMovesCopyHint } from './bundled-skill-setup-copy'

/** Says what Replace moves before the click; other actions render the button as is. */
export function BundledSkillReplaceHint({
  replacing,
  action,
  children
}: {
  /** The button reads Replace now; false while it runs. */
  replacing: boolean
  /** The plan Replace would run; names the planned host's backups folder. */
  action: BundledSkillInstallActionState | undefined
  children: ReactElement
}): ReactElement {
  const t = useTranslate()
  if (action?.kind !== 'replace') {
    return children
  }
  // Why wrap for the whole Replace action: dropping the wrapper on click would remount the
  // focused button mid-run.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {replacing ? (
        <TooltipContent side="top" sideOffset={4}>
          {bundledSkillReplaceMovesCopyHint(action.backup, t)}
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}
