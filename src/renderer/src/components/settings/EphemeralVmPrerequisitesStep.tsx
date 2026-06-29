import type React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// Why: the only prerequisite Orca owns is its own CLI on PATH (auto-detected). The
// cloud account and git token are the user's — listed for orientation, never confirmed.
export function EphemeralVmPrerequisitesStep({
  orcaCliReady
}: {
  orcaCliReady: boolean
}): React.JSX.Element {
  return (
    <ul className="space-y-2 text-sm">
      <PrereqItem
        detected={orcaCliReady}
        label={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqCli',
          'Orca CLI on your PATH'
        )}
        detail={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqCliDetail',
          'Detected automatically — used by the skill terminal.'
        )}
      />
      <PrereqItem
        detected={false}
        label={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqAccount',
          'A cloud sandbox account + its CLI, signed in'
        )}
        detail={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqAccountDetail',
          'A provider that gives you on-demand Linux VMs.'
        )}
      />
      <PrereqItem
        detected={false}
        label={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqToken',
          'A git token for private clones'
        )}
        detail={translate(
          'auto.components.settings.EphemeralVmSetupPlan.prereqTokenDetail',
          "So the VM can clone your repo (e.g. a GH_TOKEN or your git host's CLI auth). Never committed."
        )}
      />
    </ul>
  )
}

function PrereqItem({
  detected,
  label,
  detail
}: {
  detected: boolean
  label: string
  detail: string
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          detected ? 'bg-emerald-500' : 'border border-border/70'
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <div>{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </li>
  )
}
