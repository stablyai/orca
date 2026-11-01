import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginDeclarativeEventArg } from '../../../../../shared/plugins/declarative/plugin-declarative-messages'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'

/** A press on one of Orca's own controls, which may grant the panel one user gesture. */
export type PluginDeclarativePress = {
  control: 'Button' | 'IconButton' | 'ListItem' | 'Link'
  /** Which tracked element the press landed on, for the settle check. */
  gestureId: string
  /** False when the same press already opened a Link's href. */
  grants: boolean
}

/** How an event came about: a press that may grant a gesture, or a numbered value edit. */
export type PluginDeclarativeEmitOptions = { press?: PluginDeclarativePress; edit?: number }

/** Fires a guest callback. */
export type PluginDeclarativeEmit = (
  callback: string,
  args: PluginDeclarativeEventArg[],
  options?: PluginDeclarativeEmitOptions
) => void

export function sendValue(emit: PluginDeclarativeEmit) {
  return (callback: string, value: PluginDeclarativeEventArg, edit: number): void =>
    emit(callback, [value], { edit })
}

export function LabelledField({
  id,
  label,
  hidden,
  children
}: {
  id: string
  label: string
  hidden: boolean | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {hidden ? null : <Label htmlFor={id}>{label}</Label>}
      {children}
    </div>
  )
}

export function PluginDeclarativeInput({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Input'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const { value, change, readOnly } = usePluginDeclarativeHostValue({
    value: props.value,
    defaultValue: props.defaultValue,
    fallback: '',
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  const submit = props.onSubmit?.$callback
  return (
    <LabelledField id={id} label={props.label} hidden={props.labelHidden}>
      <Input
        id={id}
        type={props.type ?? 'text'}
        value={value}
        readOnly={readOnly}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-label={props.labelHidden ? props.label : undefined}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (submit && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            // The host owns the text, so Enter submits exactly what is on screen.
            emit(submit, [value])
          }
        }}
      />
    </LabelledField>
  )
}

export function PluginDeclarativeSwitch({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Switch'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const { value, change, readOnly } = usePluginDeclarativeHostValue({
    value: props.checked,
    defaultValue: props.defaultChecked,
    fallback: false,
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <Label htmlFor={id}>{props.label}</Label>
      <Switch
        id={id}
        checked={value}
        disabled={props.disabled || readOnly}
        onCheckedChange={change}
      />
    </div>
  )
}

export function PluginDeclarativeSelect({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Select'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const { value, change, readOnly } = usePluginDeclarativeHostValue({
    value: props.value,
    defaultValue: props.defaultValue,
    fallback: '',
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  return (
    <LabelledField id={id} label={props.label} hidden={props.labelHidden}>
      <Select value={value} onValueChange={change} disabled={props.disabled || readOnly}>
        <SelectTrigger
          id={id}
          size="sm"
          className="w-full"
          aria-label={props.labelHidden ? props.label : undefined}
        >
          <SelectValue placeholder={props.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </LabelledField>
  )
}
