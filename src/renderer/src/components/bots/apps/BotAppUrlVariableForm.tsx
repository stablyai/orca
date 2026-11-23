// An app whose URL has a blank: its site picked from a list, or its host typed behind Advanced,
// before the app is added.
import React, { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botMcpAppHost,
  botMcpAppUrl,
  type BotMcpAppSite,
  type BotMcpAppUrlVariable
} from '../../../../../shared/bots/bot-mcp-apps'
import { BotAppStepHeading } from './BotAppStepParts'
import { sitePlace, urlVariableHint, urlVariableLabel } from './bot-app-url-variable-copy'
import type { BotMcpAppPreset } from './BotAppUrlStep'

export function BotAppUrlVariableForm({
  className,
  app,
  variable,
  onAdd
}: {
  className: string
  app: BotMcpAppPreset
  variable: BotMcpAppUrlVariable
  onAdd: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const fieldId = useId()
  const hintId = useId()
  const choices = 'choices' in variable ? variable.choices : null
  const [value, setValue] = useState(choices ? variable.default : '')
  const [expanded, setExpanded] = useState(false)
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        const filled = choices ? value : botMcpAppHost(value)
        if (filled === null) {
          setInvalid(true)
          setExpanded(true)
          return
        }
        onAdd(botMcpAppUrl(app, filled))
      }}
    >
      <BotAppStepHeading
        logo={app.logo}
        title={t('bots.apps.mcp.addTitle', 'Add {{app}}', { app: app.title })}
        line={app.line}
      />
      {choices ? (
        <SitePicker
          id={fieldId}
          label={urlVariableLabel(t, app.name, variable)}
          choices={choices}
          value={value}
          onValue={setValue}
        />
      ) : 'hint' in variable ? (
        <>
          <Button
            type="button"
            variant="disclosure"
            size="sm"
            aria-expanded={expanded}
            aria-controls={hintId}
            onClick={() => setExpanded(!expanded)}
            className="-ml-2"
          >
            {t('bots.apps.mcp.advanced', 'Advanced')}
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </Button>
          {expanded ? (
            <div className="mt-3">
              <Label htmlFor={fieldId} className="mb-1.5">
                {urlVariableLabel(t, app.name, variable)}
              </Label>
              <Input
                id={fieldId}
                className="w-64"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={variable.placeholder}
                value={value}
                aria-invalid={invalid}
                aria-describedby={hintId}
                onChange={(event) => {
                  setValue(event.target.value)
                  setInvalid(false)
                }}
              />
              <p
                id={hintId}
                role={invalid ? 'alert' : undefined}
                className={cn(
                  'mt-1.5 text-xs',
                  invalid ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {invalid
                  ? t('bots.apps.mcp.hostInvalid', 'Enter a host name, like {{example}}.', {
                      example: variable.placeholder
                    })
                  : urlVariableHint(t, app.name, variable.hint)}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button type="submit" size="sm">
          {t('bots.apps.add', 'Add')}
        </Button>
      </div>
    </form>
  )
}

/** One compact select of the vendor's site names, the place muted beside each; no addresses. */
function SitePicker({
  id,
  label,
  choices,
  value,
  onValue
}: {
  id: string
  label: string
  choices: readonly BotMcpAppSite[]
  value: string
  onValue: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <Label htmlFor={id} className="mb-1.5">
        {label}
      </Label>
      <Select value={value} onValueChange={onValue}>
        <SelectTrigger id={id} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.name}
              <span className="text-muted-foreground">· {sitePlace(t, choice)}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}
