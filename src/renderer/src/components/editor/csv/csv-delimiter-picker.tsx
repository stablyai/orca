import { useId } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export const CSV_DELIMITER_CHOICES = [
  { choice: 'comma', delimiter: ',' },
  { choice: 'semicolon', delimiter: ';' },
  { choice: 'tab', delimiter: '\t' },
  { choice: 'pipe', delimiter: '|' }
] as const

export type CsvDelimiterChoice = 'auto' | (typeof CSV_DELIMITER_CHOICES)[number]['choice']

export function CsvDelimiterPicker({
  value,
  detectedDelimiter,
  onChange
}: {
  value: CsvDelimiterChoice
  detectedDelimiter: string
  onChange: (choice: CsvDelimiterChoice) => void
}): React.JSX.Element {
  const id = useId()
  const names: Record<Exclude<CsvDelimiterChoice, 'auto'>, string> = {
    comma: translate('auto.components.editor.CsvViewer.delimiterComma', 'Comma'),
    semicolon: translate('auto.components.editor.CsvViewer.delimiterSemicolon', 'Semicolon'),
    tab: translate('auto.components.editor.CsvViewer.delimiterTab', 'Tab'),
    pipe: translate('auto.components.editor.CsvViewer.delimiterPipe', 'Pipe')
  }
  const detected = CSV_DELIMITER_CHOICES.find((entry) => entry.delimiter === detectedDelimiter)
  const choices: { value: CsvDelimiterChoice; label: string }[] = [
    {
      value: 'auto',
      label: translate('auto.components.editor.CsvViewer.delimiterAuto', 'Auto ({{delimiter}})', {
        delimiter: detected ? names[detected.choice] : detectedDelimiter
      })
    },
    ...CSV_DELIMITER_CHOICES.map(({ choice, delimiter }) => ({
      value: choice,
      label: choice === 'tab' ? names.tab : `${names[choice]} (${delimiter})`
    }))
  ]

  return (
    <div className="ms-auto flex items-center gap-2">
      <Label htmlFor={id}>
        {translate('auto.components.editor.CsvViewer.delimiter', 'Delimiter')}
      </Label>
      <Select
        value={value}
        onValueChange={(nextValue) => {
          const choice = choices.find((candidate) => candidate.value === nextValue)
          if (choice) {
            onChange(choice.value)
          }
        }}
      >
        <SelectTrigger id={id} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
