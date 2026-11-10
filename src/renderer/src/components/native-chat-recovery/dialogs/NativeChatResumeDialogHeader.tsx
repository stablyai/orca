import { RotateCcw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog'
import type { ResumeRunPanel } from '../runs/NativeChatResumeRunPanel'

export function NativeChatResumeDialogHeader({
  runPanel,
  machineName,
  remote,
  interruptedByUpdate
}: {
  runPanel: ResumeRunPanel | null
  machineName?: string
  remote: boolean
  interruptedByUpdate: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogHeader>
      <DialogTitle>
        {/* Plain wrapper owns the icon spacing; DialogTitle owns its own. */}
        {remote && runPanel ? (
          <>
            {machineName}: {runPanel.title}
          </>
        ) : (
          (runPanel?.title ?? (
            <span className="flex items-center gap-2">
              <RotateCcw className="size-4 text-muted-foreground" />
              {remote
                ? t(
                    'auto.components.NativeChatResumeOnRestartModal.serverTitle',
                    '{{machine}} restarted',
                    { machine: machineName }
                  )
                : t(
                    'auto.components.NativeChatResumeOnRestartModal.title',
                    'Resume interrupted chats?'
                  )}
            </span>
          ))
        )}
      </DialogTitle>
      <DialogDescription>
        {runPanel?.description ??
          (remote
            ? t(
                'auto.components.NativeChatResumeOnRestartModal.serverBody',
                'These chats were working when Orca on {{machine}} restarted. Resuming restores each one where it stopped and asks the agent to carry on. Your own prompt is not re-sent.',
                { machine: machineName }
              )
            : interruptedByUpdate
              ? t(
                  'auto.components.NativeChatResumeOnRestartModal.updateBody',
                  'These chats were working when Orca installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
                )
              : t(
                  'auto.components.NativeChatResumeOnRestartModal.body',
                  'These chats were working when Orca closed. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
                ))}
      </DialogDescription>
      {runPanel?.summary}
    </DialogHeader>
  )
}
