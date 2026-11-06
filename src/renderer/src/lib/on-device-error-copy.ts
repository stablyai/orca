import { translate } from '@/i18n/i18n'
import type { TextGenerationFailureCode } from '../../../shared/text-generation-failure-copy'

type CopyValues = Record<string, string | number>

export type OnDeviceErrorCopyCode = Extract<TextGenerationFailureCode, `onDeviceModel${string}`>

// Merged into the text-generation copy table; the on-device provider has no CLI to describe.
export const ON_DEVICE_ERROR_COPY: Record<OnDeviceErrorCopyCode, (values: CopyValues) => string> = {
  onDeviceModelUnavailable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelUnavailable',
      'The on-device model is not available. Turn on Apple Intelligence in System Settings, or pick another agent.',
      values
    ),
  onDeviceModelContextExceeded: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelContextExceeded',
      'This request is too large for the on-device model. Stage fewer changes, or pick another agent.',
      values
    ),
  onDeviceModelRefused: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelRefused',
      'The on-device model declined this request.',
      values
    ),
  onDeviceModelLocale: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelLocale',
      'The on-device model does not support this language.',
      values
    ),
  onDeviceModelBusy: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelBusy',
      'The on-device model is busy. Try again in a moment.',
      values
    ),
  onDeviceModelFailed: (values) =>
    translate(
      'sourceControl.textGeneration.errors.onDeviceModelFailed',
      'The on-device model failed: {{detail}}',
      values
    )
}
