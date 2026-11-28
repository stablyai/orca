import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { sanitizeHydratedActiveView } from '@/store/slices/ui/ui-slice-hydration-sanitizers'
import { selectShownRailDestinationsKey } from './app-rail-destinations'

const shownWith = (overrides: Partial<NonNullable<AppState['settings']>>): string[] =>
  selectShownRailDestinationsKey({
    settings: { ...getDefaultSettings('/fixture-home'), ...overrides }
  }).split(',')

it('keeps Plugins off the rail for new profiles and for profiles saved before the setting existed', () => {
  expect(shownWith({})).not.toContain('plugins')
  expect(shownWith({ showPluginsButton: undefined })).not.toContain('plugins')
})

it('never restores a paired web client onto the desktop-only Plugins page', () => {
  expect(sanitizeHydratedActiveView('plugins', true)).toBe('terminal')
  expect(sanitizeHydratedActiveView('plugins', false)).toBe('plugins')
})
