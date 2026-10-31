import { translate } from '@/i18n/i18n'
import type { SmartGitHubSubmitIntent } from '@/lib/smart-github-submit'
import { isDefaultGitHubHost } from '../../../../shared/github/repository-identity-key'

export function getUnresolvedSmartGitHubSubmitMessage(
  intent: SmartGitHubSubmitIntent,
  lookedUpInSingleGitProject: boolean
): string {
  // Why: owner/repo lookups only succeed for the project's origin or upstream remote,
  // so name the linked repo instead of a generic failure the user can't act on.
  if (intent.kind === 'link' && lookedUpInSingleGitProject) {
    const slug = `${intent.owner}/${intent.repo}`
    const repository = isDefaultGitHubHost(intent.host) ? slug : `${intent.host}/${slug}`
    return translate(
      'auto.hooks.useComposerState.githubLinkUnresolvedForProject',
      'Could not load {{repository}}#{{number}}. Check that it exists, that you can access it, and that it belongs to the origin or upstream repository of the selected project.',
      { repository, number: intent.number }
    )
  }
  return translate(
    'auto.hooks.useComposerState.githubItemUnresolved',
    'Could not resolve the GitHub item before creating the workspace.'
  )
}
