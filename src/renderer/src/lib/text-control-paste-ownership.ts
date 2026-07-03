import { isPrimarySelectionTextControl } from './primary-selection-capture'
import {
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  measureTextControlPasteByteLength
} from './text-control-paste'

export type TextControlPastePayloadOwnership =
  | {
      action: 'allow-native'
      reason: 'empty' | 'small'
      byteLength: number
      exceededLimit: false
    }
  | {
      action: 'claim-orca'
      byteLength: number
      exceededLimit: true
    }
  | {
      action: 'reject'
      reason: 'too-large'
      byteLength: number
      exceededLimit: true
    }

export function findOwnedTextControlPasteTarget(
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(activeElement instanceof Element)) {
    return null
  }
  const textControl = activeElement.closest('input, textarea')
  if (!textControl || !isPrimarySelectionTextControl(textControl)) {
    return null
  }
  if (textControl.disabled || textControl.readOnly) {
    return null
  }
  return textControl
}

export function findOwnedPasteEventTextControlTarget(
  eventTarget: EventTarget | null,
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(eventTarget instanceof Element)) {
    return null
  }
  if (eventTarget.closest('.xterm-helper-textarea')) {
    return null
  }
  const textControl = eventTarget.closest('input, textarea')
  if (!textControl || activeElement !== textControl) {
    return null
  }
  return findOwnedTextControlPasteTarget(textControl)
}

export function classifyTextControlPastePayloadOwnership(
  text: string,
  options: {
    directMaxBytes?: number
    maxBytes?: number
  } = {}
): TextControlPastePayloadOwnership {
  if (!text) {
    return {
      action: 'allow-native',
      reason: 'empty',
      byteLength: 0,
      exceededLimit: false
    }
  }

  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  const directMaxBytes = options.directMaxBytes ?? TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  const ownershipMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  if (!ownershipMeasurement.exceededLimit) {
    return {
      action: 'allow-native',
      reason: 'small',
      byteLength: ownershipMeasurement.byteLength,
      exceededLimit: false
    }
  }

  if (text.length > maxBytes || directMaxBytes >= maxBytes) {
    return {
      action: 'reject',
      reason: 'too-large',
      byteLength: measureRejectedTextControlPasteByteLength(text, maxBytes),
      exceededLimit: true
    }
  }

  return {
    action: 'claim-orca',
    byteLength: ownershipMeasurement.byteLength,
    exceededLimit: true
  }
}

export function shouldClaimTextControlPastePayload(
  text: string,
  options: {
    directMaxBytes?: number
    maxBytes?: number
  } = {}
): boolean {
  return classifyTextControlPastePayloadOwnership(text, options).action !== 'allow-native'
}

function measureRejectedTextControlPasteByteLength(text: string, maxBytes: number): number {
  if (maxBytes <= TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES) {
    return measureTextControlPasteByteLength(text, { stopAfterBytes: maxBytes }).byteLength
  }
  return maxBytes + 1
}
