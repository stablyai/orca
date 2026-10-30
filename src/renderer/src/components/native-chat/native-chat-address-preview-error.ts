import { CHAT_ADDRESS_PREVIEW_CLIENT_ERROR } from '../../../../shared/chat-address-preview'
import { translate } from '@/i18n/i18n'

/** Never render arbitrary backend errors: filesystem and network errors can include secrets. */
export function addressPreviewErrorMessage(message: string): string {
  switch (message) {
    case CHAT_ADDRESS_PREVIEW_CLIENT_ERROR.desktopRequired:
      return translate(
        'components.native-chat.addressPreview.desktopRequired',
        'Address previews require the desktop app.'
      )
    case 'Preview network policy is not ready':
      return translate(
        'components.native-chat.addressPreview.networkPolicyPending',
        'Network settings are not ready. Try again after the proxy connection is available.'
      )
    case 'Address previews cannot bypass the configured network proxy':
      return translate(
        'components.native-chat.addressPreview.proxyUnavailable',
        'This address requires a proxy that previews cannot use safely. Preview a local copy instead.'
      )
    case 'Preview file exceeds the size limit':
      return translate(
        'components.native-chat.addressPreview.tooLarge',
        'This file is too large to preview.'
      )
    case 'Preview content changed during the read':
      return translate(
        'components.native-chat.addressPreview.contentChanged',
        'The file changed while loading. Retry to read the current version.'
      )
    case 'Preview count limit reached':
    case 'Preview network request limit reached':
      return translate(
        'components.native-chat.addressPreview.limitReached',
        'Too many previews are active. Remove a preview and try again.'
      )
    case 'Preview DNS lookup timed out':
    case 'Preview request timed out':
      return translate(
        'components.native-chat.addressPreview.timedOut',
        'The address took too long to respond. Check the connection and try again.'
      )
    case 'Only credential-free HTTP(S) preview URLs are allowed':
      return translate(
        'components.native-chat.addressPreview.unsupportedAddress',
        'Use an HTTP or HTTPS address without an embedded username or password.'
      )
    case 'Only absolute local regular-file paths can be previewed':
      return translate(
        'components.native-chat.addressPreview.unsupportedPath',
        'Use an absolute path to a local file. Folders and network shares cannot be previewed.'
      )
    case 'Image preview has invalid or unsupported raster dimensions':
    case 'Image dimensions exceed the preview safety limit':
      return translate(
        'components.native-chat.addressPreview.unsupportedImage',
        'This image has unsupported dimensions or is too large to display safely.'
      )
    case 'Preview released':
      return translate(
        'components.native-chat.addressPreview.released',
        'This preview is no longer available. Retry to load it again.'
      )
    default:
      return translate(
        'components.native-chat.addressPreview.unavailable',
        'Could not load this preview. Check the address and try again.'
      )
  }
}
