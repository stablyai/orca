import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'

export function CustomAgentCommandField({
  id,
  value,
  onChange,
  description
}: {
  id: string
  value: string
  onChange: (value: string) => void
  description?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={id}>
          {t('auto.components.settings.CommitMessageAiPane.47e45cbd5a', 'Custom command')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {description ?? (
            <>
              {t(
                'auto.components.settings.CommitMessageAiPane.4f722a5f53',
                'Used by commit-message, pull-request, and branch-name recipes that select Custom command. Use'
              )}{' '}
              <code className="font-mono">
                {t('auto.components.settings.CommitMessageAiPane.b8b6fd55b4', '{prompt}')}
              </code>{' '}
              {t(
                'auto.components.settings.CommitMessageAiPane.3f1b26cc91',
                'to pass the command input as an argument; otherwise Orca pipes it on stdin.'
              )}
            </>
          )}
        </p>
      </div>
      <Input
        id={id}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t(
          'auto.components.settings.CommitMessageAiPane.15b60d54b2',
          'e.g. ollama run llama3.1 {prompt}'
        )}
        className="h-8 font-mono text-xs"
      />
    </div>
  )
}
