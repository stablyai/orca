import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { odooUpdateTicketComment } from '@/runtime/runtime-odoo-client'
import { translate } from '@/i18n/i18n'
import type { OdooComment, OdooTicket } from '../../../shared/odoo-types'
/** Inline edit form for an existing chatter message; Odoo-style pencil-to-textarea swap. */
export function OdooTicketCommentEditor({
  comment,
  ticket,
  onSaved,
  onCancel
}: {
  comment: OdooComment
  ticket: OdooTicket
  onSaved: () => void
  onCancel: () => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [draft, setDraft] = useState(comment.body)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || saving) {
      return
    }
    setSaving(true)
    try {
      const result = await odooUpdateTicketComment(settings, comment.id, body, ticket.instanceId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      onSaved()
    } catch {
      toast.error(
        translate(
          'auto.components.odoo.ticket.comment.editor.1f08f23e28',
          'Could not update the message.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <textarea
        autoFocus
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          // Cross-platform save: ⌘⏎ on Mac, Ctrl+Enter elsewhere, matching the composer.
          const submitModifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
          if (submitModifier && event.key === 'Enter') {
            event.preventDefault()
            void save()
          }
        }}
        rows={3}
        className="min-h-16 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          {translate('auto.components.odoo.ticket.comment.editor.a51eb9cb0b', 'Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!draft.trim() || saving}
          onClick={() => void save()}
        >
          {saving ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            translate('auto.components.odoo.ticket.comment.editor.3d15a0fae6', 'Save')
          )}
        </Button>
      </div>
    </div>
  )
}
