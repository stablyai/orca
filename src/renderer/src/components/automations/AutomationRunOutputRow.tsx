import React from 'react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { ChevronRight, Download, ExternalLink, FileCode, FileText } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { restrictedMediaMarkdownExtension } from '@/components/sidebar/comment-markdown-restricted-media'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { AutomationRunOutput } from '../../../../shared/automation-run-result-types'
import { AutomationRunHtmlPreview } from './AutomationRunHtmlPreview'

export type AutomationRunOutputActions = {
  /** Resolves the stored file content; rejects when the host no longer has it. */
  load: (outputId: string) => Promise<string>
  open: (output: AutomationRunOutput) => Promise<void>
  download: (output: AutomationRunOutput) => Promise<void>
}

// File-format names are not translated.
const OUTPUT_FORMAT_NAME = { html: 'HTML', markdown: 'Markdown' } as const

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
}

function IconAction({
  label,
  onClick,
  disabled,
  pending,
  children
}: {
  label: string
  onClick: () => void
  disabled: boolean
  pending: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {pending ? (
            <span className="animate-in fade-in duration-0 [animation-delay:200ms] [animation-fill-mode:both]">
              <LoadingSpinner className="size-4" />
            </span>
          ) : (
            children
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function OutputPreview({
  output,
  load
}: {
  output: AutomationRunOutput
  load: AutomationRunOutputActions['load']
}): React.JSX.Element {
  const [state, setState] = React.useState<
    { kind: 'loading' } | { kind: 'ready'; content: string } | { kind: 'failed'; error: unknown }
  >({ kind: 'loading' })
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0)
  React.useEffect(() => {
    let current = true
    setState({ kind: 'loading' })
    load(output.id).then(
      (content) => current && setState({ kind: 'ready', content }),
      (error: unknown) => current && setState({ kind: 'failed', error })
    )
    return () => {
      current = false
    }
  }, [load, output.id, attempt])
  if (state.kind === 'failed') {
    return (
      <div className="mt-2 text-sm text-muted-foreground">
        <p>
          {translate(
            'auto.components.automations.AutomationRunResults.previewFailed',
            "Couldn't load preview."
          )}{' '}
          {extractIpcErrorMessage(state.error, String(state.error))}
        </p>
        <Button type="button" variant="outline" size="xs" className="mt-2" onClick={retry}>
          {translate('auto.components.automations.AutomationRunResults.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (state.kind === 'loading') {
    return <div className="mt-2 h-24 rounded-lg border border-border/50 bg-card" />
  }
  return output.format === 'html' ? (
    <AutomationRunHtmlPreview id={output.id} title={output.title} content={state.content} />
  ) : (
    <div className="mt-2 rounded-lg border border-border/50 bg-card px-5 py-4">
      <CommentMarkdown
        variant="document"
        extension={restrictedMediaMarkdownExtension}
        renderMermaid={false}
        content={state.content}
        className="text-sm leading-relaxed text-foreground"
      />
    </div>
  )
}

export function AutomationRunOutputRow({
  output,
  actions
}: {
  output: AutomationRunOutput
  actions: AutomationRunOutputActions
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = React.useState<'open' | 'download' | null>(null)
  const perform = async (action: 'open' | 'download'): Promise<void> => {
    if (pendingAction) {
      return
    }
    setPendingAction(action)
    try {
      await actions[action](output)
    } finally {
      setPendingAction(null)
    }
  }
  const Icon = output.format === 'html' ? FileCode : FileText
  return (
    <Collapsible asChild defaultOpen>
      <li>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger variant="row" className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="truncate text-sm font-medium text-foreground">{output.title}</span>
                <span className="text-xs text-muted-foreground">
                  {OUTPUT_FORMAT_NAME[output.format]} · {formatBytes(output.bytes)}
                </span>
              </span>
            </span>
          </CollapsibleTrigger>
          <IconAction
            label={translate(
              'auto.components.automations.AutomationRunResults.saveAndOpen',
              'Save and open'
            )}
            disabled={pendingAction !== null}
            pending={pendingAction === 'open'}
            onClick={() => void perform('open')}
          >
            <ExternalLink className="size-4" />
          </IconAction>
          <IconAction
            label={translate(
              'auto.components.automations.AutomationRunResults.download',
              'Download'
            )}
            disabled={pendingAction !== null}
            pending={pendingAction === 'download'}
            onClick={() => void perform('download')}
          >
            <Download className="size-4" />
          </IconAction>
        </div>
        <CollapsibleContent forceMount className="data-[state=closed]:hidden">
          <OutputPreview output={output} load={actions.load} />
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}
