import React, { useId, useState } from 'react'
import { Clock3, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  canQueueVmCreationPrompt,
  queueVmCreationPrompt,
  vmCreationFirstPrompt,
  vmCreationPromptIsDraft
} from '@/lib/workspace/creation/vm-creation-queued-prompt'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'

export type OrcaCloudQueuedPromptViewProps = {
  agentName: string
  /** The prompt the agent starts with; empty when none is queued. */
  prompt: string
  /** False once the build has moved past provisioning and the prompt is handed to the launch. */
  editable: boolean
  /** The prompt is typed into the agent unsent rather than sent. */
  draft?: boolean
  onQueue: (text: string) => void
}

/** Queue the agent's first prompt while the workspace builds; it starts with it once ready. */
export function OrcaCloudQueuedPromptView({
  agentName,
  prompt,
  editable,
  draft: isDraftDelivery = false,
  onQueue
}: OrcaCloudQueuedPromptViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const inputId = useId()
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(prompt ? null : '')
  const editing = editable && draft !== null
  // Typing that the build outran stays on screen, so the text isn't lost silently.
  const lateDraft =
    !editable && draft !== null && draft.trim() && draft.trim() !== prompt.trim()
      ? draft.trim()
      : null
  if (!editable && !prompt && !lateDraft) {
    return null
  }
  const submit = (): void => {
    const text = (draft ?? '').trim()
    if (!text) {
      return
    }
    onQueue(text)
    setDraft(null)
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5" data-orca-cloud-queued-prompt="editing">
        <label htmlFor={inputId} className="text-xs font-medium text-foreground">
          {t('auto.components.orcaCloud.QueuedPrompt.label', 'First prompt for {{agent}}', {
            agent: agentName
          })}
        </label>
        <Textarea
          id={inputId}
          aria-describedby={hintId}
          value={draft}
          rows={3}
          className="min-h-16 resize-none"
          placeholder={t(
            'auto.components.orcaCloud.QueuedPrompt.placeholder',
            'What should {{agent}} work on?',
            { agent: agentName }
          )}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape' && prompt) {
              event.preventDefault()
              setDraft(null)
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <p id={hintId} className="text-xs text-muted-foreground">
            {t(
              'auto.components.orcaCloud.QueuedPrompt.hint',
              '{{agent}} starts with it as soon as the workspace is ready.',
              { agent: agentName }
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {prompt ? (
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                {t('auto.components.orcaCloud.QueuedPrompt.cancelEdit', 'Cancel')}
              </Button>
            ) : null}
            <Button size="xs" variant="secondary" disabled={!draft.trim()} onClick={submit}>
              {t('auto.components.orcaCloud.QueuedPrompt.queue', 'Queue prompt')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (lateDraft) {
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
        data-orca-cloud-queued-prompt="late"
        role="status"
      >
        <p className="text-xs font-medium text-foreground">
          {prompt
            ? t(
                'auto.components.orcaCloud.QueuedPrompt.lateEdit',
                'Too late to change: {{agent}} is starting with the queued prompt. Send your edit once the workspace opens:',
                { agent: agentName }
              )
            : t(
                'auto.components.orcaCloud.QueuedPrompt.lateQueue',
                'Too late to queue: {{agent}} is already starting. Send this once the workspace opens:',
                { agent: agentName }
              )}
        </p>
        <p className="line-clamp-4 text-xs whitespace-pre-wrap break-words text-muted-foreground select-text">
          {lateDraft}
        </p>
      </div>
    )
  }

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
      data-orca-cloud-queued-prompt="queued"
    >
      <Clock3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">
          {editable && isDraftDelivery
            ? t(
                'auto.components.orcaCloud.QueuedPrompt.draftQueued',
                'Draft for {{agent}}, typed in when ready',
                { agent: agentName }
              )
            : editable
              ? t('auto.components.orcaCloud.QueuedPrompt.queued', 'Queued for {{agent}}', {
                  agent: agentName
                })
              : isDraftDelivery
                ? t(
                    'auto.components.orcaCloud.QueuedPrompt.drafting',
                    'Ready as a draft in {{agent}}',
                    { agent: agentName }
                  )
                : t('auto.components.orcaCloud.QueuedPrompt.sending', 'Sending to {{agent}} next', {
                    agent: agentName
                  })}
        </p>
        <p className="mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {prompt}
        </p>
      </div>
      {editable ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('auto.components.orcaCloud.QueuedPrompt.edit', 'Edit queued prompt')}
          onClick={() => setDraft(prompt)}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}

/** Mount in a VM create's build surface; renders nothing for creates without an agent. */
export function OrcaCloudQueuedPrompt({
  creationId
}: {
  creationId: string
}): React.JSX.Element | null {
  const entry = useAppStore((state) => state.pendingWorktreeCreations[creationId])
  if (!entry?.request.ephemeralVmRecipe || entry.request.agent === null) {
    return null
  }
  return (
    <OrcaCloudQueuedPromptView
      key={creationId}
      agentName={tuiAgentDisplayName(entry.request.agent) ?? entry.request.agent}
      prompt={vmCreationFirstPrompt(entry)}
      draft={vmCreationPromptIsDraft(entry)}
      editable={canQueueVmCreationPrompt(entry)}
      onQueue={(text) => queueVmCreationPrompt(creationId, text)}
    />
  )
}
