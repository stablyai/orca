import type React from 'react'
import { Moon } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'

/** Whole minutes left before the sandbox sleeps, never below one while it is still awake. */
export function minutesUntilSleep(sleepsAt: number, now: number): number {
  return Math.max(1, Math.ceil((sleepsAt - now) / 60_000))
}

/**
 * Under a blocked Orca Cloud create: when its unused sandbox stops spending hours. A sandbox never
 * runs on "until you choose"; it sleeps after a few unused minutes, like any idle workspace.
 */
export function BlockedSandboxHoursNote({
  sleepsAt,
  sandbox
}: {
  sleepsAt: number | undefined
  sandbox: 'sleeping' | 'asleep' | 'deleted' | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const counting = sandbox === undefined && sleepsAt !== undefined
  // Minute resolution is enough for a "Sleeps in N min" line.
  const now = useNow(15_000, counting)
  if (sandbox === 'deleted') {
    return null
  }
  const text =
    sandbox === 'asleep'
      ? t(
          'auto.components.worktree.creation.BlockedSandboxHoursNote.asleep',
          'Asleep. It isn’t using sandbox hours.'
        )
      : sandbox === 'sleeping'
        ? t('auto.components.worktree.creation.BlockedSandboxHoursNote.sleeping', 'Going to sleep…')
        : sleepsAt === undefined
          ? null
          : t(
              'auto.components.worktree.creation.BlockedSandboxHoursNote.sleepsIn',
              'Sleeps in {{count}} minutes if unused.',
              {
                count: minutesUntilSleep(sleepsAt, now),
                defaultValue_one: 'Sleeps in {{count}} minute if unused.'
              }
            )
  if (!text) {
    return null
  }
  return (
    <p
      data-blocked-sandbox-sleep={sandbox ?? 'awake'}
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Moon aria-hidden className="size-3.5 shrink-0" />
      {text}
    </p>
  )
}
