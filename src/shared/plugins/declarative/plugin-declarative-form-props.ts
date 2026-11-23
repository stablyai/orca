import { z } from 'zod'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import {
  callback,
  component,
  editAck,
  flag,
  label,
  languageId,
  requiredLabel,
  text
} from './plugin-declarative-prop-schemas'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Form controls added in catalog 2 (Orca 1.4.247). Each value control follows the edit protocol. */

const textareaProps = lazyZodSchema(() =>
  z
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
)
const checkboxProps = lazyZodSchema(() =>
  z
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
)
const radioGroupProps = lazyZodSchema(() =>
  z
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
)
const finite = lazyZodSchema(() => z.number().refine(Number.isFinite, 'must be finite'))
const sliderProps = lazyZodSchema(() =>
  z
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
)
export const PLUGIN_DECLARATIVE_COMPLETION_KINDS = [
  'field',
  'operator',
  'function',
  'keyword',
  'value'
] as const
/** A position in the text: a UTF-16 index, as JavaScript strings count. */
const textOffset = lazyZodSchema(() => z.number().int().nonnegative().max(LIMITS.maxTextLength))
const codeInputProps = lazyZodSchema(() =>
  z
    .object({
      label: requiredLabel,
      labelHidden: flag,
      value: text.optional(),
      defaultValue: text.optional(),
      placeholder: label.optional(),
      language: languageId.optional(),
      /** Visible lines, 1 to 20. With 1 the text is one line that wraps: Enter submits. */
      rows: z.number().int().min(1).max(20).optional(),
      /** Grows with its text up to this many lines, then scrolls. */
      maxRows: z.number().int().min(1).max(20).optional(),
      maxLength: z.number().int().positive().max(LIMITS.maxTextLength).optional(),
      invalid: flag,
      disabled: flag,
      /** Offered for the word before the cursor, filtered by Orca as the person types. */
      completions: z
        .array(
          z
            .object({
              label: requiredLabel,
              detail: label.optional(),
              /** Inserted instead of `label`. */
              insert: text.optional(),
              kind: z.enum(PLUGIN_DECLARATIVE_COMPLETION_KINDS).optional()
            })
            .strict()
        )
        .max(LIMITS.maxCodeInputCompletions)
        .optional(),
      /** Characters that open and close a string; typing inside one offers no completions.
       *  Ctrl+Space still does. */
      quotes: z.string().min(1).max(8).optional(),
      /** Ranges of `value` drawn underlined; dropped while the text on screen is newer. */
      diagnostics: z
        .array(
          z
            .object({
              from: textOffset,
              to: textOffset,
              message: requiredLabel,
              tone: z.enum(['danger', 'warning']).optional()
            })
            .strict()
        )
        .max(LIMITS.maxCodeInputDiagnostics)
        .optional(),
      onChange: callback,
      onSubmit: callback,
      ...editAck
    })
    .strict()
)
const fieldProps = lazyZodSchema(() =>
  z
    .object({
      label: requiredLabel,
      description: label.optional(),
      /** Shown in the danger tone and announced; also marks the field invalid. */
      error: label.optional(),
      required: flag
    })
    .strict()
)

export const PLUGIN_DECLARATIVE_FORM_CATALOG = {
  Textarea: component(textareaProps, 'none'),
  Checkbox: component(checkboxProps, 'none'),
  RadioGroup: component(radioGroupProps, 'none'),
  Slider: component(sliderProps, 'none'),
  Field: component(fieldProps, 'any'),
  // Catalog 5.
  CodeInput: component(codeInputProps, 'none')
} as const
