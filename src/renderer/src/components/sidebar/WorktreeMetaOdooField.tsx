import React from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

// Single instance per dialog, so a fixed id is enough to name the input.
const ODOO_TICKET_FIELD_ID = 'worktree-meta-odoo-ticket'

/** Odoo ticket link field for the worktree meta dialog. Extracted so the dialog
 *  stays under the max-lines limit. Only rendered when Odoo is connected. */
export function WorktreeMetaOdooField({
  value,
  onChange,
  onEnter
}: {
  value: string
  onChange: (value: string) => void
  onEnter: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <label
        htmlFor={ODOO_TICKET_FIELD_ID}
        className="text-[11px] font-medium text-muted-foreground"
      >
        {translate('auto.components.sidebar.WorktreeMetaDialog.odoo_ticket_label', 'Odoo Ticket')}
      </label>
      <Input
        id={ODOO_TICKET_FIELD_ID}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onEnter()
          }
        }}
        placeholder={translate(
          'auto.components.sidebar.WorktreeMetaDialog.odoo_ticket_placeholder',
          'Ticket # or Odoo URL'
        )}
        className="h-8 text-xs"
      />
      <p className="text-[10px] text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.odoo_ticket_hint',
          'Paste an Odoo task URL, or enter a number. Leave blank to remove the link.'
        )}
      </p>
    </div>
  )
}
