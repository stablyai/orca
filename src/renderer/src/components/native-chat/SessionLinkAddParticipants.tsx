import { useState } from 'react'
import type { SessionLinkParticipant } from '../../../../shared/session-link'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { SessionLinkParticipantPicker } from './SessionLinkParticipantPicker'

export function SessionLinkAddParticipants({
  candidates,
  busy,
  initialSessionId,
  onAdd
}: {
  candidates: SessionLinkParticipant[]
  busy: boolean
  initialSessionId?: string
  onAdd: (sessionIds: string[]) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()

  const [open, setOpen] = useState(Boolean(initialSessionId))
  const [selected, setSelected] = useState<string[]>(initialSessionId ? [initialSessionId] : [])
  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(!open)}>
        {t('components.sessionLink.addParticipants', 'Add agents')}
      </Button>
      {open ? (
        <>
          <SessionLinkParticipantPicker
            candidates={candidates}
            selected={selected}
            disabled={busy}
            onSelect={(id) =>
              setSelected((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]))
            }
          />
          <Button
            variant="secondary"
            disabled={
              busy ||
              !selected.length ||
              selected.some((id) => !candidates.some((p) => p.sessionId === id))
            }
            onClick={() =>
              void onAdd(selected).then((ok) => {
                if (ok) {
                  setSelected([])
                  setOpen(false)
                }
              })
            }
          >
            {t('components.sessionLink.addSelected', 'Add selected agents')}
          </Button>
        </>
      ) : null}
    </div>
  )
}
