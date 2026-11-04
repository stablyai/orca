import { ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function TaskPageNoConnectedSource(): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const openIntegrationSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'integrations', repoId: null })
  }

  return (
    <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
      <ListTodo className="mb-4 size-8 text-muted-foreground/60" />
      <p className="text-base font-medium text-foreground">
        {translate('auto.components.task-page.NoConnectedSource.title', 'Connect a task source')}
      </p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {translate(
          'auto.components.task-page.NoConnectedSource.description',
          'Sign in to GitHub or GitLab, or connect Jira or Linear, to browse and start work from your tasks here.'
        )}
      </p>
      <Button className="mt-5" onClick={openIntegrationSettings}>
        {translate('auto.components.task-page.NoConnectedSource.action', 'Open integrations')}
      </Button>
    </div>
  )
}
