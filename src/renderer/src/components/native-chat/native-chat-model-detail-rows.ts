import { getIntlLocale, translate } from '@/i18n/i18n'
import type {
  NativeChatModelDetails,
  NativeChatModelInputKind
} from '../../../../shared/native-chat/input/native-chat-model-details'
import { formatContextTokenCount } from './native-chat-context-usage-summary'

export type NativeChatModelDetailRow = {
  id: 'provider' | 'inputs' | 'reasoning' | 'context'
  label: string
  value: string
}

function inputLabel(kind: NativeChatModelInputKind): string {
  switch (kind) {
    case 'text':
      return translate('components.native-chat.modelDetails.inputText', 'Text')
    case 'image':
      return translate('components.native-chat.modelDetails.inputImage', 'Image')
    case 'audio':
      return translate('components.native-chat.modelDetails.inputAudio', 'Audio')
    case 'video':
      return translate('components.native-chat.modelDetails.inputVideo', 'Video')
  }
}

/** One row per stated fact, in card order; unknown facts get no row. */
export function nativeChatModelDetailRows(
  details: NativeChatModelDetails
): NativeChatModelDetailRow[] {
  const rows: NativeChatModelDetailRow[] = []
  if (details.provider) {
    rows.push({
      id: 'provider',
      label: translate('components.native-chat.modelDetails.provider', 'Provider'),
      value: details.provider
    })
  }
  if (details.inputs?.length) {
    rows.push({
      id: 'inputs',
      label: translate('components.native-chat.modelDetails.inputs', 'Inputs'),
      value: new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
        details.inputs.map(inputLabel)
      )
    })
  }
  if (details.reasoning !== undefined) {
    rows.push({
      id: 'reasoning',
      label: translate('components.native-chat.modelDetails.reasoning', 'Reasoning'),
      value: details.reasoning
        ? translate('components.native-chat.modelDetails.supported', 'Supported')
        : translate('components.native-chat.modelDetails.notSupported', 'Not supported')
    })
  }
  if (details.contextWindowTokens) {
    rows.push({
      id: 'context',
      label: translate('components.native-chat.modelDetails.contextWindow', 'Context window'),
      value: translate('components.native-chat.modelDetails.contextTokens', '{{tokens}} tokens', {
        tokens: formatContextTokenCount(details.contextWindowTokens)
      })
    })
  }
  return rows
}
