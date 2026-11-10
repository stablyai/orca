import { z } from 'zod'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import {
  callback,
  component,
  editAck,
  flag,
  label,
  requiredLabel,
  text
} from './plugin-declarative-prop-schemas'

/** Form controls added in catalog 2 (Orca 1.4.247). Each value control follows the edit protocol. */

const textareaProps = z
  .object({
    label: requiredLabel,
    labelHidden: flag,
    value: text.optional(),
    defaultValue: text.optional(),
    placeholder: label.optional(),
    rows: z.number().int().min(2).max(20).optional(),
    maxLength: z.number().int().positive().max(LIMITS.maxTextLength).optional(),
    invalid: flag,
    disabled: flag,
    onChange: callback,
    onSubmit: callback,
    ...editAck
  })
  .strict()
const checkboxProps = z
  .object({
    label: requiredLabel,
    description: label.optional(),
    checked: flag,
    defaultChecked: flag,
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const radioGroupProps = z
  .object({
    label: requiredLabel,
    labelHidden: flag,
    value: label.optional(),
    defaultValue: label.optional(),
    options: z
      .array(
        z
          .object({
            value: requiredLabel,
            label: requiredLabel,
            description: label.optional(),
            disabled: flag
          })
          .strict()
      )
      .max(LIMITS.maxRadioOptions),
    orientation: z.enum(['vertical', 'horizontal']).optional(),
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const finite = z.number().refine(Number.isFinite, 'must be finite')
const sliderProps = z
  .object({
    label: requiredLabel,
    labelHidden: flag,
    value: finite.optional(),
    defaultValue: finite.optional(),
    min: finite.optional(),
    max: finite.optional(),
    step: z.number().positive().refine(Number.isFinite).optional(),
    /** Shows the current value next to the label. */
    showValue: flag,
    disabled: flag,
    onChange: callback,
    ...editAck
  })
  .strict()
const fieldProps = z
  .object({
    label: requiredLabel,
    description: label.optional(),
    /** Shown in the danger tone and announced; also marks the field invalid. */
    error: label.optional(),
    required: flag
  })
  .strict()

export const PLUGIN_DECLARATIVE_FORM_CATALOG = {
  Textarea: component(textareaProps, 'none'),
  Checkbox: component(checkboxProps, 'none'),
  RadioGroup: component(radioGroupProps, 'none'),
  Slider: component(sliderProps, 'none'),
  Field: component(fieldProps, 'any')
} as const
