import React, { useMemo, useState } from 'react'
import { Download, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { workflowMessagesToCsv } from '../../../../../shared/workflow/workflow-metrics'
import type {
  WorkflowMessage,
  WorkflowRun
} from '../../../../../shared/workflow/workflow-run-types'
import { saveWorkflowTextFile } from '../workflow-file-export'
import { workflowRunActions } from '../workflow-run-actions'
import { getIntlLocale, translate } from '@/i18n/i18n'

const ALL = '__all__'

const STATE_TONE: Record<WorkflowMessage['deliveryState'], string> = {
  delivered: 'text-muted-foreground',
  truncated: 'text-status-warning-text',
  held: 'text-status-warning-text',
  rejected: 'text-destructive',
  'dropped-by-approval': 'text-muted-foreground'
}

function FilterSelect({
  value,
  onChange,
  options,
  label
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  label: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" density="compact" className="h-7 w-36" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>
          {label}
          {translate('auto.components.workflows.execution.WorkflowMessageLog.48d779f471', ': all')}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MessageDetail({ message }: { message: WorkflowMessage }) {
  const [reply, setReply] = useState('')
  return (
    <div className="space-y-2 border-t border-border bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span>
          {translate(
            'auto.components.workflows.execution.WorkflowMessageLog.ef63fddc80',
            'Correlation'
          )}
          <span className="font-mono">{message.correlationId}</span>
        </span>
        {message.orcaMessageId ? (
          <span>
            {translate(
              'auto.components.workflows.execution.WorkflowMessageLog.f2d0eb7abd',
              'Orca message'
            )}
            <span className="font-mono">{message.orcaMessageId}</span>
          </span>
        ) : null}
        <span>
          {message.bytes}{' '}
          {translate('auto.components.workflows.execution.WorkflowMessageLog.a41a4a7b37', 'B · ~')}
          {message.estimatedTokens}{' '}
          {translate(
            'auto.components.workflows.execution.WorkflowMessageLog.c3bf3b8c13',
            'tokens (estimated)'
          )}
        </span>
      </div>
      {message.rejection ? (
        <p className="text-xs text-destructive">
          {message.rejection.code}: {message.rejection.reason}
        </p>
      ) : null}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-2xs scrollbar-sleek">
        {message.payload ||
          translate(
            'auto.components.workflows.execution.WorkflowMessageLog.748840570a',
            'Payload not kept (metadata-only logging).'
          )}
      </pre>
      {message.deliveryState === 'held' ? (
        <div className="flex gap-2">
          <Button
            size="xs"
            onClick={() => void workflowRunActions.releaseMessage(message.id, 'deliver')}
          >
            {translate(
              'auto.components.workflows.execution.WorkflowMessageLog.cea871b963',
              'Deliver'
            )}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void workflowRunActions.releaseMessage(message.id, 'drop')}
          >
            {translate('auto.components.workflows.execution.WorkflowMessageLog.8b89ca85b7', 'Drop')}
          </Button>
        </div>
      ) : null}
      {message.type === 'question' && message.orcaMessageId ? (
        <div className="flex items-end gap-2">
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={2}
            placeholder={translate(
              'auto.components.workflows.execution.WorkflowMessageLog.4e109ceb51',
              'Answer the worker'
            )}
            density="compact"
          />
          <Button
            size="xs"
            disabled={!reply.trim()}
            onClick={() =>
              void workflowRunActions
                .reply(message.id, reply.trim())
                .then((ok) => ok && setReply(''))
            }
          >
            <Send />
            {translate(
              'auto.components.workflows.execution.WorkflowMessageLog.3fd27fdbc9',
              'Reply'
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function WorkflowMessageLog({ run }: { run: WorkflowRun }): React.JSX.Element {
  const [agent, setAgent] = useState(ALL)
  const [type, setType] = useState(ALL)
  const [state, setState] = useState(ALL)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const labels = useMemo(
    () => new Map(run.definition.nodes.map((node) => [node.id, node.label])),
    [run.definition.nodes]
  )
  const messages = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return run.messages
      .filter(
        (message) =>
          agent === ALL || message.sourceNodeId === agent || message.destinationNodeId === agent
      )
      .filter((message) => type === ALL || message.type === type)
      .filter((message) => state === ALL || message.deliveryState === state)
      .filter((message) => !needle || message.payload.toLowerCase().includes(needle))
      .toReversed()
  }, [run.messages, agent, type, state, query])
  const types = [...new Set(run.messages.map((message) => message.type))]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <FilterSelect
          label={translate(
            'auto.components.workflows.execution.WorkflowMessageLog.3bd1be43e3',
            'Agent'
          )}
          value={agent}
          onChange={setAgent}
          options={run.definition.nodes
            .filter((node) => labels.has(node.id))
            .map((node) => ({ value: node.id, label: node.label }))}
        />
        <FilterSelect
          label={translate(
            'auto.components.workflows.execution.WorkflowMessageLog.56418b1b11',
            'Type'
          )}
          value={type}
          onChange={setType}
          options={types.map((entry) => ({ value: entry, label: entry }))}
        />
        <FilterSelect
          label={translate(
            'auto.components.workflows.execution.WorkflowMessageLog.f534de5749',
            'State'
          )}
          value={state}
          onChange={setState}
          options={['delivered', 'truncated', 'held', 'rejected', 'dropped-by-approval'].map(
            (entry) => ({ value: entry, label: entry })
          )}
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate(
            'auto.components.workflows.execution.WorkflowMessageLog.734faecdb3',
            'Search payloads'
          )}
          density="compact"
          className="max-w-52"
        />
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void saveWorkflowTextFile(
                workflowMessagesToCsv(run.messages),
                `${run.presetName}-messages`,
                'csv'
              )
            }
          >
            <Download />
            {translate('auto.components.workflows.execution.WorkflowMessageLog.b74a8b5176', 'CSV')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void saveWorkflowTextFile(
                JSON.stringify(run.messages, null, 2),
                `${run.presetName}-messages`,
                'json'
              )
            }
          >
            <Download />
            {translate('auto.components.workflows.execution.WorkflowMessageLog.b110bd4d55', 'JSON')}
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {messages.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.workflows.execution.WorkflowMessageLog.2c52ce2bb7',
              'No messages match.'
            )}
          </li>
        ) : null}
        {messages.map((message) => (
          <li key={message.id} className="border-b border-border/60">
            <button
              type="button"
              onClick={() => setOpen(open === message.id ? null : message.id)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-accent"
              aria-expanded={open === message.id}
            >
              <span className="w-20 shrink-0 whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground">
                {new Date(message.timestamp).toLocaleTimeString(getIntlLocale())}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">
                  {labels.get(message.sourceNodeId ?? '') ??
                    translate(
                      'auto.components.workflows.execution.WorkflowMessageLog.854a494c7f',
                      'Coordinator'
                    )}
                </span>
                <span className="text-muted-foreground"> → </span>
                <span className="font-medium">
                  {labels.get(message.destinationNodeId ?? '') ??
                    translate(
                      'auto.components.workflows.execution.WorkflowMessageLog.854a494c7f',
                      'Coordinator'
                    )}
                </span>
              </span>
              <span className="w-28 shrink-0 truncate text-2xs text-muted-foreground">
                {message.type}
              </span>
              <span className="w-16 shrink-0 text-2xs text-muted-foreground">
                {message.channel === 'controller'
                  ? translate(
                      'auto.components.workflows.execution.WorkflowMessageLog.eebd574c3d',
                      'route'
                    )
                  : translate(
                      'auto.components.workflows.execution.WorkflowMessageLog.57ab662005',
                      'direct'
                    )}
              </span>
              <span className="w-14 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                {message.bytes} B
              </span>
              <span
                className={cn(
                  'w-24 shrink-0 text-right text-2xs font-medium',
                  STATE_TONE[message.deliveryState]
                )}
              >
                {message.deliveryState}
              </span>
            </button>
            {open === message.id ? <MessageDetail message={message} /> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
