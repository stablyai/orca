import { useEffect, useMemo, useRef } from 'react'
import {
  applyChangelistTemplate,
  type PerforceSettings
} from '../../../../../shared/perforce/perforce-settings'
import type { PerforceStatusResult } from '../../../../../shared/perforce/perforce-types'

/** The configured description template with {user}/{client} filled in; seeds the message box once status loads. */
export function usePerforceDescriptionTemplate(
  settings: PerforceSettings,
  status: PerforceStatusResult | null,
  setMessage: (message: string) => void
): string {
  const applied = useRef(false)
  const template = useMemo(
    () =>
      applyChangelistTemplate(settings.newChangelistDescriptionTemplate, {
        user: status?.info.user,
        client: status?.info.client
      }),
    [settings.newChangelistDescriptionTemplate, status?.info.user, status?.info.client]
  )
  useEffect(() => {
    if (status && !applied.current) {
      applied.current = true
      setMessage(template)
    }
  }, [status, template, setMessage])
  return template
}
