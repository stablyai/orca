import { useCallback, useEffect, useState } from 'react'
import { Eraser, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { OfficeHostOwner } from '../../../../../shared/office-host-owner'
import type { OfficeDocumentLocation } from '@/lib/office-preview-plan'
import { officeMarksTitle } from './office-preview-status'
import type { OfficeMark } from '../../../../../shared/office-preview-contracts'

/**
 * Marks held by the watch process for this document.
 *
 * Ephemeral review state, not saved annotations: they live in the watch process and vanish with
 * it, which is why the panel disappears entirely when no watch process holds the document rather
 * than showing an empty list that reads like "no annotations".
 *
 * Read side only. Applying a mark is the agent's job — that is where the judgement belongs.
 */
export function OfficeMarksPanel({
  owner,
  document
}: {
  owner: OfficeHostOwner | null
  document: OfficeDocumentLocation | null
}): React.JSX.Element | null {
  const [marks, setMarks] = useState<OfficeMark[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!owner || !document) {
      return
    }
    let disposed = false
    void window.api.office
      .marks({ owner, ...document })
      .then((outcome) => {
        if (!disposed) {
          // A failure here means no watch process holds the document, which is the same thing as
          // "no marks" from the reader's side.
          setMarks(outcome.ok ? outcome.marks : [])
        }
      })
      .catch(() => {
        if (!disposed) {
          setMarks([])
        }
      })
    return () => {
      disposed = true
    }
  }, [attempt, document, owner])

  const jump = useCallback(
    (elementPath: string) => {
      if (owner && document) {
        void window.api.office.goto({ owner, ...document, elementPath })
      }
    },
    [document, owner]
  )

  const clear = useCallback(() => {
    if (!owner || !document) {
      return
    }
    void window.api.office
      .clearMarks({ owner, ...document })
      .then(() => setAttempt((count) => count + 1))
      .catch(() => setAttempt((count) => count + 1))
  }, [document, owner])

  if (marks.length === 0) {
    return null
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {officeMarksTitle(marks.length)}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" onClick={clear}>
          <Eraser className="size-3" />
          {translate('auto.components.office.preview.clearMarks', 'Clear')}
        </Button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {marks.map((mark) => (
          <li key={mark.id}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted"
              onClick={() => jump(mark.path)}
            >
              <MapPin className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{mark.path}</span>
              {mark.note ? <span className="min-w-0 truncate">{mark.note}</span> : null}
              {mark.stale ? (
                <span className="shrink-0 text-[10px] uppercase">
                  {translate('auto.components.office.preview.markStale', 'stale')}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
