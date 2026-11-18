import { translate } from '@/i18n/i18n'

export type IssueCopyTarget = 'url' | 'key' | 'identifier' | 'branchName' | 'prompt'

// Whole sentences per target: copied nouns need their own case/gender in other languages.
export function issueCopiedMessage(target: IssueCopyTarget): string {
  switch (target) {
    case 'url':
      return translate('auto.components.issueCopy.urlCopied', 'URL copied')
    case 'key':
      return translate('auto.components.issueCopy.keyCopied', 'Key copied')
    case 'identifier':
      return translate('auto.components.issueCopy.identifierCopied', 'Identifier copied')
    case 'branchName':
      return translate('auto.components.issueCopy.branchNameCopied', 'Branch name copied')
    case 'prompt':
      return translate('auto.components.issueCopy.promptCopied', 'Prompt copied')
  }
}

export function issueCopyFailedMessage(target: IssueCopyTarget): string {
  switch (target) {
    case 'url':
      return translate('auto.components.issueCopy.urlCopyFailed', 'Failed to copy URL')
    case 'key':
      return translate('auto.components.issueCopy.keyCopyFailed', 'Failed to copy key')
    case 'identifier':
      return translate(
        'auto.components.issueCopy.identifierCopyFailed',
        'Failed to copy identifier'
      )
    case 'branchName':
      return translate(
        'auto.components.issueCopy.branchNameCopyFailed',
        'Failed to copy branch name'
      )
    case 'prompt':
      return translate('auto.components.issueCopy.promptCopyFailed', 'Failed to copy prompt')
  }
}
