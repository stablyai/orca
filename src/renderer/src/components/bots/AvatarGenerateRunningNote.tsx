// The line under the Generate description field while a picture is made: how long it usually takes.
import React, { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { AvatarImageAgent } from '../../../../shared/avatar-generation/avatar-generation-contract'
import {
  AVATAR_SLOW_FACTOR,
  AVATAR_TYPICAL_SECONDS
} from '../../../../shared/avatar-generation/avatar-generation-typical-time'

/** The run the line describes; `live` is false while the line folds away after the run ends. */
export type RunningNote = { agent: AvatarImageAgent; startedAt: number; live: boolean }

export function RunningNoteLine({ note }: { note: RunningNote }): React.JSX.Element {
  const t = useTranslate()
  const { agent, startedAt, live } = note
  const typical = AVATAR_TYPICAL_SECONDS[agent]
  const slowAt = startedAt + typical * AVATAR_SLOW_FACTOR * 1000
  const [slowFor, setSlowFor] = useState<number | null>(() =>
    Date.now() >= slowAt ? startedAt : null
  )
  const slow = slowFor === startedAt
  useEffect(() => {
    if (!live || slow) {
      return
    }
    // One switch, not a tick: the line changes only when the run passes its usual time.
    const timer = setTimeout(() => setSlowFor(startedAt), Math.max(0, slowAt - Date.now()))
    return () => clearTimeout(timer)
  }, [live, slow, slowAt, startedAt])
  return (
    <p role="status" className="mt-1.5 px-0.5 text-xs leading-snug text-muted-foreground">
      {slow
        ? t('bots.avatar.generate.slow', 'Taking longer than usual. You can cancel anytime.')
        : t('bots.avatar.generate.typical', '{{agent}} usually takes about {{seconds}} seconds.', {
            agent: getAgentLabel(agent),
            seconds: typical
          })}
    </p>
  )
}
