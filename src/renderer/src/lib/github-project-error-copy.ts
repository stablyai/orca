import { translate } from '@/i18n/i18n'

/** Map stable English GitHub project error messages to the active UI locale. */
export function formatGitHubProjectErrorMessage(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  if (raw === 'Project or view not found.' || raw.includes('Project or view not found.')) {
    return translate(
      'auto.components.github.project.error.projectOrViewNotFound',
      'Project or view not found.'
    )
  }
  if (raw === 'Project not found.' || raw.includes('Project not found.')) {
    return translate('auto.components.github.project.error.projectNotFound', 'Project not found.')
  }
  if (
    raw === 'Could not find the selected view.' ||
    raw.includes('Could not find the selected view.')
  ) {
    return translate(
      'auto.components.github.project.error.selectedViewNotFound',
      'Could not find the selected view.'
    )
  }
  if (
    raw === 'Could not find this project or view.' ||
    raw.includes('Could not find this project or view.')
  ) {
    return translate(
      'auto.lib.github.project.error.copy.7ef26724e4',
      'Could not find this project or view.'
    )
  }
  if (
    raw === 'Network error — check your connection.' ||
    raw.includes('Network error — check your connection.')
  ) {
    return translate(
      'auto.components.github.project.error.networkError',
      'Network error — check your connection.'
    )
  }
  return raw
}
