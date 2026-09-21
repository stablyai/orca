import { translate } from '@/i18n/i18n'

/**
 * The one copy pair for hiding a session from the grid. Three surfaces offer it —
 * the card header, the toolbar's reveal chip and the tab bar's context menu — and
 * they have to name the same action the same way, so none of them spells it itself.
 */
export function sessionGridVisibilityActionLabel(isHiddenFromGrid: boolean): string {
  return isHiddenFromGrid
    ? translate(
        'auto.components.session.grid.session.grid.visibility.labels.366251c781',
        'Show in session grid'
      )
    : translate(
        'auto.components.session.grid.session.grid.visibility.labels.f32a13596e',
        'Hide from session grid'
      )
}
