import { translate } from '@/i18n/i18n'

export function nativeChatAnnotationCopy() {
  return {
    count: (count: number) =>
      count === 1
        ? translate('components.native-chat.annotations.countOne', '1 annotation')
        : translate('components.native-chat.annotations.count', '{{count}} annotations', { count }),
    add: translate('components.native-chat.annotations.add', 'Add annotation'),
    title: translate('components.native-chat.annotations.title', 'Annotations'),
    comment: translate('components.native-chat.annotations.comment', 'Comment'),
    save: translate('components.native-chat.annotations.save', 'Save annotation'),
    cancel: translate('components.native-chat.annotations.cancel', 'Cancel'),
    edit: translate('components.native-chat.annotations.edit', 'Edit annotation'),
    remove: translate('components.native-chat.annotations.remove', 'Delete annotation'),
    retry: translate('components.native-chat.annotations.retry', 'Retry saving annotations'),
    locate: translate('components.native-chat.annotations.locate', 'Show original text'),
    collapse: translate('components.native-chat.annotations.collapse', 'Collapse annotations'),
    expand: translate('components.native-chat.annotations.expand', 'Expand annotations'),
    notSaved: translate(
      'components.native-chat.annotations.notSaved',
      'Annotations could not be saved on this device.'
    ),
    originalUnavailable: translate(
      'components.native-chat.annotations.originalUnavailable',
      'Original text is not currently displayed.'
    )
  }
}
