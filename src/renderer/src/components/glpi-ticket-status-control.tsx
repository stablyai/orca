import React from 'react'
import { LoaderCircle } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GlpiTicket, GlpiTicketStatus } from '../../../shared/types'

export const GLPI_TICKET_STATUS_ORDER: GlpiTicketStatus[] = [
  'new',
  'assigned',
  'planned',
  'pending',
  'solved',
  'closed'
]

// Why: GLPI's "assigned" lifecycle state reads as "Processing" in the product
// UI, so the drawer mirrors GLPI's own labels rather than the raw status key.
export function getGlpiStatusLabel(status: GlpiTicketStatus): string {
  switch (status) {
    case 'new':
      return translate('auto.components.glpi.ticket.status.control.14941fe48a', 'New')
    case 'assigned':
      return translate('auto.components.glpi.ticket.status.control.3e93e05deb', 'Processing')
    case 'planned':
      return translate('auto.components.glpi.ticket.status.control.adb93b9970', 'Planned')
    case 'pending':
      return translate('auto.components.glpi.ticket.status.control.c34203c96f', 'Pending')
    case 'solved':
      return translate('auto.components.glpi.ticket.status.control.8e1ce241d9', 'Solved')
    case 'closed':
      return translate('auto.components.glpi.ticket.status.control.cf6b31a56d', 'Closed')
  }
}

// GLPI urgency/priority share a 1 (very low) .. 5 (very high) scale.
export function getGlpiScaleLabel(value: number): string {
  switch (value) {
    case 5:
      return translate('auto.components.glpi.ticket.status.control.c8914a7b29', 'Very high')
    case 4:
      return translate('auto.components.glpi.ticket.status.control.0549b49055', 'High')
    case 3:
      return translate('auto.components.glpi.ticket.status.control.86a21a6624', 'Medium')
    case 2:
      return translate('auto.components.glpi.ticket.status.control.aedf2be080', 'Low')
    case 1:
      return translate('auto.components.glpi.ticket.status.control.31b46d0f80', 'Very low')
    default:
      return `P${value}`
  }
}

export function getGlpiTypeLabel(type: GlpiTicket['type']): string {
  return type === 'incident'
    ? translate('auto.components.glpi.ticket.status.control.e660a662d2', 'Incident')
    : translate('auto.components.glpi.ticket.status.control.96564a25b0', 'Request')
}

export function getGlpiStatusToneClass(status: GlpiTicketStatus): string {
  if (status === 'solved' || status === 'closed') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (status === 'assigned' || status === 'planned') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  if (status === 'pending') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

type GlpiTicketStatusControlProps = {
  status: GlpiTicketStatus
  pending: boolean
  onChange: (next: GlpiTicketStatus) => void
}

export function GlpiTicketStatusControl({
  status,
  pending,
  onChange
}: GlpiTicketStatusControlProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
          getGlpiStatusToneClass(status)
        )}
      >
        {getGlpiStatusLabel(status)}
        {pending ? <LoaderCircle className="size-3 animate-spin" /> : null}
      </span>
      <Select
        value={status}
        disabled={pending}
        onValueChange={(next) => onChange(next as GlpiTicketStatus)}
      >
        <SelectTrigger size="sm" className="h-7 text-[11px]">
          <SelectValue
            aria-label={translate(
              'auto.components.glpi.ticket.status.control.0c1c2fd027',
              'Change status'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {GLPI_TICKET_STATUS_ORDER.map((value) => (
            <SelectItem key={value} value={value} className="text-[12px]">
              {getGlpiStatusLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
