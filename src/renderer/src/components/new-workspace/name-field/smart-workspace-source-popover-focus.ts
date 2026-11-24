import type { FocusEvent } from 'react'

export const WORKSPACE_COMPOSER_ROOT_SELECTOR = '[data-workspace-composer-root="true"]'

export function isComposerFieldToFieldFocus(
  event: Pick<FocusEvent<HTMLElement>, 'currentTarget' | 'relatedTarget'>
): boolean {
  const related = event.relatedTarget
  if (!(related instanceof HTMLElement)) {
    return false
  }
  const composer = event.currentTarget.closest(WORKSPACE_COMPOSER_ROOT_SELECTOR)
  return composer !== null && composer.contains(related)
}
