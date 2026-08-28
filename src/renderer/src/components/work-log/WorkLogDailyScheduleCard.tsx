import type React from 'react'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { WorkLogEntry } from '../../../../shared/work-log-types'
import {
  formatClockRange,
  formatDuration,
  getEntryProviderLabel,
  getEntryTitle,
  minutesBetween
} from './work-log-page-data'

export function WorkLogDailyScheduleCard({
  dayEntries,
  onDelete
}: {
  dayEntries: WorkLogEntry[]
  onDelete: (entryId: string) => void
}): React.JSX.Element {
  return (
    <Card className="min-h-0 border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Daily schedule</CardTitle>
        <CardDescription>
          Time blocks for the selected day. Use the block list to keep the log tied to the
          work item or activity that produced it.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0">
        {dayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
            No blocks yet for this day. Capture a badge block or add one below.
          </div>
        ) : (
          <ScrollArea className="h-[26rem] rounded-lg border border-border/60 bg-muted/10">
            <div className="space-y-2 p-3">
              {dayEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border border-border/60 bg-background/90 p-3 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={entry.badgeDerived ? 'secondary' : 'outline'}>
                          {getEntryProviderLabel(entry.provider)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatClockRange(entry.startAt, entry.endAt)}
                        </span>
                      </div>
                      <div className="truncate text-sm font-medium">{getEntryTitle(entry)}</div>
                      {entry.notes ? (
                        <div className="text-xs text-muted-foreground">{entry.notes}</div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        {formatDuration(minutesBetween(entry.startAt, entry.endAt))}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onDelete(entry.id)}
                        aria-label={translate(
                          'auto.components.worklog.WorkLogPage.delete',
                          'Delete block'
                        )}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
