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

export type CsvDelimiterChoice = 'auto' | 'comma' | 'semicolon' | 'tab'

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
  const comma = translate('auto.components.editor.CsvViewer.delimiterComma', 'Comma')
  const semicolon = translate('auto.components.editor.CsvViewer.delimiterSemicolon', 'Semicolon')
  const tab = translate('auto.components.editor.CsvViewer.delimiterTab', 'Tab')
  const detectedName =
    detectedDelimiter === ',' ? comma : detectedDelimiter === ';' ? semicolon : tab
  const choices = [
    {
      value: 'auto',
      label: translate('auto.components.editor.CsvViewer.delimiterAuto', 'Auto ({{delimiter}})', {
        delimiter: detectedName
      })
    },
    { value: 'comma', label: `${comma} (,)` },
    { value: 'semicolon', label: `${semicolon} (;)` },
    { value: 'tab', label: tab }
  ] as const

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
