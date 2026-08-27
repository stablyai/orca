import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LinearIcon } from '@/components/task-page-localized-options'
import { translate } from '@/i18n/i18n'

export function LinearStatusLoading(): React.JSX.Element {
  return (
    <div className="mt-4 flex items-center justify-center py-14" role="status">
      <LoaderCircle
        className="size-5 animate-spin text-muted-foreground"
        aria-label={translate(
          'auto.components.task.page.linear.linear.connect.empty.3e00e8ebd4',
          'Loading Linear'
        )}
      />
    </div>
  )
}

export function LinearConnectEmpty({
  onOpenConnect
}: {
  onOpenConnect: () => void
}): React.JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
      <LinearIcon className="mb-4 size-8 text-muted-foreground/60" />
      <p className="text-base font-medium text-foreground">
        {translate('auto.components.TaskPage.6d56559467', 'Connect your Linear account')}
      </p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {translate(
          'auto.components.TaskPage.228b25028f',
          'Browse and start work on your assigned Linear issues directly from here.'
        )}
      </p>
      <Button
        className="mt-5"
        onClick={() => {
          onOpenConnect()
        }}
      >
        {translate('auto.components.TaskPage.851017590d', 'Add Linear access')}
      </Button>
    </div>
  )
}
