import type React from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ExternalTaskActivity } from '../../../../shared/external-task-types'

function formatDate(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

export function ExternalTaskActivityFeed({
  activity,
  emptyLabel
}: {
  activity: ExternalTaskActivity[]
  emptyLabel: string
}): React.JSX.Element {
  if (activity.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>{emptyLabel}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {activity.map((entry) => (
        <Card key={entry.id} className="gap-4">
          <CardHeader className="pb-0">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <CardTitle className="text-sm">{entry.title ?? 'Activity'}</CardTitle>
                <CardDescription className="mt-1">
                  {[entry.author, formatDate(entry.createdAt)].filter(Boolean).join(' · ')}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {entry.kind ? <Badge variant="secondary">{entry.kind}</Badge> : null}
                {entry.isPublic ? <Badge variant="outline">Public</Badge> : null}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{entry.body}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
