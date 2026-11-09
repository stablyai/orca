import { defineFixture } from '../../component-fixtures/component-fixture'
import { InlineError } from '../ui/inline-error'
import { useTranslate } from '@/i18n/use-translate'
import { describeError } from './cloud-workspace-errors'

/**
 * The copy links raise. In the app these are bottom-right toasts, which sit outside a fixture frame,
 * so they are shown here in the shared InlineError tones: neutral for notices, error for failures.
 */
function LinkMessages(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-3">
      <InlineError
        tone="neutral"
        title={t('auto.components.cloudWorkspaces.workspaceLinkCopied', 'Workspace link copied')}
      />
      <InlineError
        tone="neutral"
        title={t('auto.components.cloudWorkspaces.chatLinkCopied', 'Chat link copied')}
      />
      <InlineError
        tone="neutral"
        title={t(
          'auto.components.cloudWorkspaces.chatGone',
          'That chat is no longer open in this workspace. Showing the workspace instead.'
        )}
      />
      <InlineError
        title={t(
          'auto.components.cloudWorkspaces.linkNotFound',
          'This link points to a private workspace, another team, or a workspace that was deleted.'
        )}
      />
      <InlineError title={describeError('forbidden', undefined, t)} />
      <InlineError
        title={t('auto.components.cloudWorkspaces.copyFailed', "Couldn't copy the link. Try again.")}
      />
    </div>
  )
}

export const linkMessages = defineFixture({
  width: 640,
  render: () => <LinkMessages />
})
