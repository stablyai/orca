import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { YouTrackConnectDialog } from '@/components/youtrack/YouTrackConnectDialog'
import { useYouTrackStore } from '@/components/youtrack/youtrack-store'
import { translate } from '@/i18n/i18n'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'

export function YouTrackSetupSteps(props: {
  connected: boolean
  checking: boolean
  visible: boolean
  canHide: boolean
  onToggleVisible: () => void
  onOpenIntegrations: () => void
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const baseUrl = useYouTrackStore((s) => s.status.baseUrl)
  const allowInsecureTls = useYouTrackStore((s) => s.status.allowInsecureTls === true)

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={props.checking ? 'in-progress' : props.connected ? 'done' : 'pending'}
          title={translate('youtrack.settings.connectTitle', 'Connect YouTrack')}
          description={
            props.connected && baseUrl
              ? allowInsecureTls
                ? translate(
                    'youtrack.settings.connectedToInsecure',
                    'Connected to {{url}} (certificate verification skipped)',
                    { url: baseUrl }
                  )
                : translate('youtrack.settings.connectedTo', 'Connected to {{url}}', {
                    url: baseUrl
                  })
              : translate(
                  'youtrack.settings.connectDescription',
                  'Add your self-hosted YouTrack address and a permanent token.'
                )
          }
          action={
            props.connected ? (
              <Button type="button" size="sm" variant="outline" onClick={props.onOpenIntegrations}>
                {translate('youtrack.settings.manage', 'Manage')}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
                {translate('youtrack.settings.add', 'Add YouTrack access')}
              </Button>
            )
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel="YouTrack"
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <YouTrackConnectDialog aboveSettings open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
