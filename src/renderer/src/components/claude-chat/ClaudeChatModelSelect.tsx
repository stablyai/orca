import React, { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/ui/select'
import { describeModel } from './model-display'

type ModelEntry = { id: string; isDefault: boolean }

type Props = {
  value: string
  onValueChange: (value: string) => void
  activeModel: string | null | undefined
}

function TriggerLabel({
  value,
  activeModel,
  models
}: {
  value: string
  activeModel: string | null | undefined
  models: ModelEntry[]
}): React.JSX.Element {
  if (value && value !== 'default') {
    return <span>{describeModel(value).name}</span>
  }
  if (activeModel) {
    return <span>{describeModel(activeModel).name}</span>
  }
  const defaultEntry = models.find((m) => m.isDefault)
  if (defaultEntry) {
    return <span>{describeModel(defaultEntry.id).name}</span>
  }
  return <span>Model</span>
}

export function ClaudeChatModelSelect({
  value,
  onValueChange,
  activeModel
}: Props): React.JSX.Element {
  const [models, setModels] = useState<ModelEntry[]>([])

  useEffect(() => {
    void window.api.claudeChat
      .listModels()
      .then((entries) => {
        setModels(entries)
      })
      .catch(() => {
        setModels([])
      })
  }, [])

  const defaultEntry = models.find((m) => m.isDefault)
  const defaultDisplay = defaultEntry ? describeModel(defaultEntry.id) : null

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        className="h-6 px-2 text-xs gap-1 border-0 bg-transparent shadow-none hover:bg-accent focus-visible:ring-0 focus-visible:border-0 w-auto"
        aria-label="Model"
      >
        {/* Why: Radix SelectValue only renders children once a value is picked —
            with no selection it falls back to the (absent) placeholder, leaving the
            trigger blank. Render our label directly so the live/default model name
            (from system:init or settings.json) always shows. */}
        <TriggerLabel value={value} activeModel={activeModel} models={models} />
      </SelectTrigger>
      {/* Why: item-aligned (default) renders the menu over the trigger, so the
          mouseup of the opening click lands inside and instantly closes it. */}
      <SelectContent position="popper">
        <SelectItem value="default">
          <div className="flex flex-col gap-0.5 py-0.5">
            <span className="font-medium text-sm leading-tight">Default (recommended)</span>
            <span className="text-xs text-muted-foreground leading-tight">
              {defaultDisplay ? defaultDisplay.description : 'Use Claude Code default model'}
            </span>
            {defaultEntry && (
              <span className="text-[10px] text-muted-foreground/60 leading-tight font-mono">
                {defaultEntry.id}
              </span>
            )}
          </div>
        </SelectItem>
        {models.map((entry) => {
          const display = describeModel(entry.id)
          return (
            <SelectItem key={entry.id} value={entry.id}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="font-medium text-sm leading-tight">{display.name}</span>
                <span className="text-xs text-muted-foreground leading-tight">
                  {display.description}
                </span>
                <span
                  className="text-[10px] text-muted-foreground/60 leading-tight font-mono"
                  title={entry.id}
                >
                  {entry.id}
                </span>
              </div>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
