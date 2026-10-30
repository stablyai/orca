import { useEffect, useState } from 'react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function StartupWorktreeRefreshStatus(): React.JSX.Element | null {
  const completed = useAppStore((s) => s.startupWorktreeRefreshCompleted)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (completed) {
      return
    }
    const timer = setTimeout(() => setVisible(true), 200)
    return () => clearTimeout(timer)
  }, [completed])

  if (completed || !visible) {
    return null
  }

  return (
    <div role="status" className="mx-3 mb-2 flex shrink-0 items-start gap-2 text-muted-foreground">
      <LoadingSpinner className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-0.5 text-xs">
        <p>{translate('sidebar.startupWorktreeRefresh.loading', 'Discovering workspaces…')}</p>
        <p>
          {translate(
            'sidebar.startupWorktreeRefresh.description',
            'More workspaces may appear while local and remote projects load.'
          )}
        </p>
      </div>
    </div>
  )
}
