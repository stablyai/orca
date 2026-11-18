import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getCreateButtonLabel(
  {
    isCreating,
    pushBeforeCreate,
    draft,
    stacked,
    shortLabel
  }: {
    isCreating: boolean
    pushBeforeCreate: boolean
    draft: boolean
    stacked: boolean
    shortLabel: string
  },
  t: Translate = translate
): string {
  if (isCreating) {
    return t('auto.components.right.sidebar.SourceControl.26511c22b4', 'Creating...')
  }
  if (pushBeforeCreate && stacked) {
    return t(
      'auto.components.right.sidebar.create.hosted.review.button.label.96ae7358e0',
      'Push & Create PR in stack'
    )
  }
  if (pushBeforeCreate) {
    return t(
      'auto.components.right.sidebar.CreateHostedReviewComposer.741ff8a0d2',
      'Push & Create {{value0}}',
      { value0: shortLabel }
    )
  }
  if (stacked) {
    return draft
      ? t(
          'auto.components.right.sidebar.create.hosted.review.button.label.8e8149a0bf',
          'Create draft PR in stack'
        )
      : t(
          'auto.components.right.sidebar.create.hosted.review.button.label.8df1a05952',
          'Create PR in stack'
        )
  }
  if (draft) {
    return t('auto.components.right.sidebar.SourceControl.aaf1451654', 'Create draft {{value0}}', {
      value0: shortLabel
    })
  }
  return t('auto.components.right.sidebar.SourceControl.5acbcedc1a', 'Create {{value0}}', {
    value0: shortLabel
  })
}
