import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'
import { LabelledField, sendValue, type PluginDeclarativeEmit } from './PluginDeclarativeControls'

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export function PluginDeclarativeTextarea({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Textarea'>
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
      <Textarea
        id={id}
        value={value}
        rows={props.rows ?? 4}
        readOnly={readOnly}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-label={props.labelHidden ? props.label : undefined}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          const modifier = IS_MAC ? event.metaKey : event.ctrlKey
          if (submit && modifier && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            emit(submit, [value])
          }
        }}
      />
    </LabelledField>
  )
}

export function PluginDeclarativeCheckbox({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Checkbox'>
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
    <div className="flex min-w-0 items-start gap-2">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={value}
        disabled={props.disabled || readOnly}
        aria-describedby={props.description ? `${id}-description` : undefined}
        onCheckedChange={(checked) => change(checked === true)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{props.label}</Label>
        {props.description ? (
          <span id={`${id}-description`} className="text-xs text-muted-foreground">
            {props.description}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function PluginDeclarativeRadioGroup({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'RadioGroup'>
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
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.labelHidden ? null : <Label id={`${id}-label`}>{props.label}</Label>}
      <RadioGroup
        value={value}
        onValueChange={change}
        disabled={props.disabled || readOnly}
        orientation={props.orientation ?? 'vertical'}
        data-orientation={props.orientation ?? 'vertical'}
        aria-labelledby={props.labelHidden ? undefined : `${id}-label`}
        aria-label={props.labelHidden ? props.label : undefined}
        className="data-[orientation=horizontal]:flex data-[orientation=horizontal]:flex-wrap"
      >
        {props.options.map((option, index) => (
          <div key={option.value} className="flex min-w-0 items-start gap-2">
            <RadioGroupItem
              id={`${id}-${index}`}
              value={option.value}
              disabled={option.disabled}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={`${id}-${index}`}>{option.label}</Label>
              {option.description ? (
                <span className="text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </div>
          </div>
        ))}
      </RadioGroup>
    </div>
  )
}

function sliderRange(props: PluginDeclarativeProps<'Slider'>) {
  const min = props.min ?? 0
  const max = Math.max(min, props.max ?? 100)
  return { min, max, step: props.step ?? 1 }
}

export function PluginDeclarativeSlider({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Slider'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const { min, max, step } = sliderRange(props)
  const { value, change, readOnly } = usePluginDeclarativeHostValue({
    value: props.value,
    defaultValue: props.defaultValue,
    fallback: min,
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  const shown = Math.min(max, Math.max(min, value))
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.labelHidden && !props.showValue ? null : (
        <div className="flex items-center justify-between gap-2">
          {props.labelHidden ? <span /> : <Label id={`${id}-label`}>{props.label}</Label>}
          {props.showValue ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{shown}</span>
          ) : null}
        </div>
      )}
      <Slider
        min={min}
        max={max}
        step={step}
        value={[shown]}
        disabled={props.disabled || readOnly}
        thumbLabels={[props.label]}
        onValueChange={([next]) => {
          if (typeof next === 'number' && next !== shown) {
            change(next)
          }
        }}
      />
    </div>
  )
}

/** A label, description and error around any controls; the group takes the label as its name. */
export function PluginDeclarativeField({
  props,
  children
}: {
  props: PluginDeclarativeProps<'Field'>
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={
        [props.description ? `${id}-description` : '', props.error ? `${id}-error` : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      aria-invalid={props.error ? true : undefined}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <span id={`${id}-label`} className="text-sm leading-none font-medium text-foreground">
        {props.label}
        {props.required ? (
          <span aria-hidden className="text-muted-foreground">
            {' *'}
          </span>
        ) : null}
      </span>
      {props.description ? (
        <span id={`${id}-description`} className="text-xs text-muted-foreground">
          {props.description}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
      {props.error ? (
        <span id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {props.error}
        </span>
      ) : null}
    </div>
  )
}
