import type React from 'react'
import { cn } from '@/lib/utils'
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
}): React.JSX.Element {
  const copy = environmentCheckCopy(check, t, cloud)
  const { message } = copy
  // Uncoded fixes end in raw CLI output; on Orca Cloud keep only the advice line above it.
  const remediation =
    cloud && !check.code ? (copy.remediation?.split('\n')[0] ?? null) : copy.remediation
  return (
    <li
      // Rows arrive together; a short stagger lets the eye read them top to bottom.
      style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'backwards' }}
      className="flex flex-col gap-0.5 text-xs motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200"
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'w-16 shrink-0 text-[11px] font-medium',
            check.status === 'fail' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {environmentCheckBadge(check.status, t)}
        </span>
        <span className="min-w-0 break-words text-foreground">{message}</span>
      </div>
      {remediation ? (
        <p className="ml-18 whitespace-pre-wrap break-words text-muted-foreground">{remediation}</p>
      ) : null}
    </li>
  )
}
