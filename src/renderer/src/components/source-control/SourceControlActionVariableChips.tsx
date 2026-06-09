import type React from 'react'
import { Braces } from 'lucide-react'
import {
  SOURCE_CONTROL_ACTION_VARIABLE_INFO,
  SOURCE_CONTROL_ACTION_VARIABLES,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
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
    Object.prototype.hasOwnProperty.call(variablePreviews, variable) &&
    variablePreviews[variable] !== undefined &&
    variablePreviews[variable] !== null
  )
}

function SourceControlVariableTooltip({
  variable,
  preview
}: {
  variable: string
  preview?: string
}): React.JSX.Element {
  if (preview !== undefined) {
    if (variable === 'basePrompt') {
      return (
        <pre className="scrollbar-sleek max-h-72 max-w-[min(32rem,calc(100vw-2rem))] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {preview || translate("auto.components.source.control.SourceControlActionVariableChips.4bf6d88039", "(empty)")}
        </pre>
      )
    }

    return (
      <div className="space-y-1.5">
        <div className="font-mono text-[11px] text-background/70">{`{${variable}}`}</div>
        <pre className="scrollbar-sleek max-h-72 max-w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-sm bg-background/10 p-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {preview || translate("auto.components.source.control.SourceControlActionVariableChips.4bf6d88039", "(empty)")}
        </pre>
      </div>
    )
  }

  const info = SOURCE_CONTROL_ACTION_VARIABLE_INFO[variable]
  return (
    <div className="max-w-80 space-y-2 text-left leading-relaxed">
      <div className="space-y-0.5">
        <div className="font-mono text-[11px]">{`{${variable}}`}</div>
        <div className="text-background/80">{info.description}</div>
      </div>
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-background/60">
          {translate("auto.components.source.control.SourceControlActionVariableChips.6b921a0ac2", "Example")}</div>
        <pre className="scrollbar-sleek max-h-40 overflow-auto rounded-sm bg-background/10 p-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {info.example}
        </pre>
      </div>
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
        {translate("auto.components.source.control.SourceControlActionVariableChips.1b77798d5f", "Variables")}</span>
      {SOURCE_CONTROL_ACTION_VARIABLES[actionId].map((variable) => {
        const preview = hasVariablePreview(variablePreviews, variable)
          ? variablePreviews?.[variable]
          : undefined
        return (
          <Tooltip key={variable}>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="px-2 py-2 text-left">
              <SourceControlVariableTooltip variable={variable} preview={preview} />
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
