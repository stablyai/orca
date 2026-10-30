import { translate } from '@/i18n/i18n'

export function taskPageGitHubLoadError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : translate('auto.components.TaskPage.loadGitHubWorkFailed', 'Failed to load GitHub work.')
}
