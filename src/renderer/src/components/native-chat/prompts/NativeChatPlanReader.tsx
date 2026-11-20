import { Maximize2 } from 'lucide-react'
import type { AgentJournalPlanApprovalSubject } from '../../../../../shared/agent-session/journal/agent-session-journal-approval-subject'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'

export function NativeChatPlanBody({
  plan
}: {
  plan: AgentJournalPlanApprovalSubject
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-native-chat-approval-plan="true">
      <NativeChatMarkdown
        content={plan.text}
        variant="document"
        className="text-sm text-chat-foreground"
        renderCodeBlock={NativeChatCodeBlock}
        linkifyFilePaths
      />
      {plan.filePath ? (
        <p className="mt-2 break-all">
          <span className="font-medium text-foreground">
            {t('components.native-chat.approval.plan.file', 'Plan file')}:{' '}
          </span>
          <span className="font-mono">{plan.filePath}</span>
        </p>
      ) : null}
    </div>
  )
}

export function NativeChatPlanReader({
  plan,
  title
}: {
  plan: AgentJournalPlanApprovalSubject
  title: string
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.approval.plan.expand', 'Expand plan')
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} title={label}>
          <Maximize2 />
        </Button>
      </DialogTrigger>
      <DialogContent
        surface="security"
        className="flex max-h-[85dvh] flex-col sm:max-w-3xl"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div
          className="min-h-0 overflow-y-auto scrollbar-sleek"
          tabIndex={0}
          role="region"
          aria-label={title}
        >
          <NativeChatPlanBody plan={plan} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
