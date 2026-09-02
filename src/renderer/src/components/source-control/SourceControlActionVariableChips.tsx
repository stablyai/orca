import type React from 'react'
import { Braces } from 'lucide-react'
import {
  SOURCE_CONTROL_ACTION_VARIABLE_INFO,
  SOURCE_CONTROL_ACTION_VARIABLES,
  type SourceControlActionVariable
} from '../../../../shared/source-control-ai-action-variables'
import type { SourceControlActionId } from '../../../../shared/source-control-ai-actions'
import { Button } from '../ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'
import { translate } from '@/i18n/i18n'

type SourceControlActionVariableChipsProps = {
  actionId: SourceControlActionId
  disabled?: boolean
  variablePreviews?: Partial<Record<string, string>>
  onInsert: (variable: string) => void
}

function hasVariablePreview(
  variablePreviews: Partial<Record<string, string>> | undefined,
  variable: string
): boolean {
  return Boolean(
    variablePreviews &&
    Object.hasOwn(variablePreviews, variable) &&
    variablePreviews[variable] !== undefined &&
    variablePreviews[variable] !== null
  )
}

function SourceControlVariableSample({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre className="rounded-sm bg-background/60 p-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {value ||
          translate(
            'auto.components.source.control.SourceControlActionVariableChips.4bf6d88039',
            '(empty)'
          )}
      </pre>
    </div>
  )
}

function SourceControlVariableDetails({
  variable,
  preview
}: {
  variable: SourceControlActionVariable
  preview?: string
}): React.JSX.Element {
  // Why: for `basePrompt` the preview *is* the content — the static card only restates it.
  if (preview !== undefined && variable === 'basePrompt') {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {preview ||
          translate(
            'auto.components.source.control.SourceControlActionVariableChips.4bf6d88039',
            '(empty)'
          )}
      </pre>
    )
  }

  const info = SOURCE_CONTROL_ACTION_VARIABLE_INFO[variable]
  return (
    <div className="max-w-80 space-y-2 text-left leading-relaxed">
      <div className="space-y-0.5">
        <div className="font-mono text-[11px]">{`{${variable}}`}</div>
        <div className="text-muted-foreground">{info.description}</div>
      </div>
      <SourceControlVariableSample
        label={translate(
          'auto.components.source.control.SourceControlActionVariableChips.6b921a0ac2',
          'Example'
        )}
        value={info.example}
      />
      {/* Why: a preview never replaces the description — it is the only in-product warning
          that a bare `Fixes #{linkedIssue}` degrades to `Fixes #` on an unlinked workspace. */}
      {preview !== undefined ? (
        <SourceControlVariableSample
          label={translate(
            'auto.components.source.control.SourceControlActionVariableChips.7377483644',
            'This workspace'
          )}
          value={preview}
        />
      ) : null}
    </div>
  )
}

export function SourceControlActionVariableChips({
  actionId,
  disabled = false,
  variablePreviews,
  onInsert
}: SourceControlActionVariableChipsProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Braces className="size-3" />
        {translate(
          'auto.components.source.control.SourceControlActionVariableChips.1b77798d5f',
          'Variables'
        )}
      </span>
      {SOURCE_CONTROL_ACTION_VARIABLES[actionId].map((variable) => {
        const preview = hasVariablePreview(variablePreviews, variable)
          ? variablePreviews?.[variable]
          : undefined
        return (
          <HoverCard key={variable} openDelay={150} closeDelay={120}>
            <HoverCardTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  className="h-5 rounded px-1.5 font-mono text-[10px]"
                  onClick={() => onInsert(variable)}
                >
                  {`{${variable}}`}
                </Button>
              </span>
            </HoverCardTrigger>
            <HoverCardContent
              side="top"
              sideOffset={6}
              collisionPadding={12}
              className="scrollbar-sleek max-h-[min(18rem,calc(100vh-2rem))] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto p-2 text-left text-xs"
            >
              <SourceControlVariableDetails variable={variable} preview={preview} />
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </div>
  )
}
