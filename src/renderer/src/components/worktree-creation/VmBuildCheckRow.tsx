import type React from 'react'
import { Badge } from '@/components/ui/badge'
import type { Translate } from '@/i18n/use-translate'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import { environmentCheckBadge, environmentCheckCopy } from './environment-check-copy'

export function CheckRow({
  check,
  index,
  cloud,
  t
}: {
  check: EnvironmentDoctorCheck
  index: number
  cloud: boolean
  t: Translate
}): React.JSX.Element | null {
  const copy = environmentCheckCopy(check, t, cloud)
  const { message } = copy
  // Uncoded fixes end in raw CLI output; on Orca Cloud keep only the advice line above it.
  const remediation =
    cloud && !check.code ? (copy.remediation?.split('\n')[0] ?? null) : copy.remediation
  return (
    <li
      // Rows arrive together; a short stagger lets the eye read them top to bottom.
      style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'backwards' }}
      // A subgrid row of the list's two columns: every pill shares the width of the longest label,
      // so messages line up in any language.
      className="col-span-2 grid grid-cols-subgrid items-baseline gap-y-0.5 text-xs motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200"
    >
      <span>
        <Badge variant={check.status === 'fail' ? 'statusFailed' : 'statusWarning'}>
          {environmentCheckBadge(check.status, t)}
        </Badge>
      </span>
      <span className="min-w-0 break-words text-foreground">{message}</span>
      {remediation ? (
        <p className="col-start-2 whitespace-pre-wrap break-words text-muted-foreground">
          {remediation}
        </p>
      ) : null}
    </li>
  )
}
