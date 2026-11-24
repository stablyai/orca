import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { UISlice } from './ui-slice-contract'
import { createUiAgentActions } from './ui-slice-agent-actions'
import { createUiTaskActions } from './ui-slice-task-actions'
import { createUiViewActions } from './ui-slice-view-actions'
import { createUiSettingsActions } from './ui-slice-settings-actions'
import { createUiModalActions } from './ui-slice-modal-actions'
import { createUiFeatureActions } from './ui-slice-feature-actions'
import { createUiTourActions } from './ui-slice-tour-actions'
import { createUiTrustActions } from './ui-slice-trust-actions'
import { createUiPreferenceActions } from './ui-slice-preference-actions'
import { createUiSurfaceActions } from './ui-slice-surface-actions'
import { createUiPersistenceActions } from './ui-slice-persistence-actions'
import { createUiHydrationActions } from './ui-slice-hydration-actions'
import { createUiUpdateActions } from './ui-slice-update-actions'
import { createUiWslMovedSectionActions } from './ui-slice-wsl-moved-section-actions'

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each creator returns a Partial<UISlice>; together they define every field, which the spread type cannot prove.
  ({
    ...createUiAgentActions(set, get),
    ...createUiTaskActions(set, get),
    ...createUiViewActions(set, get),
    ...createUiSettingsActions(set, get),
    ...createUiModalActions(set, get),
    ...createUiFeatureActions(set, get),
    ...createUiTourActions(set, get),
    ...createUiTrustActions(set, get),
    ...createUiPreferenceActions(set, get),
    ...createUiSurfaceActions(set, get),
    ...createUiPersistenceActions(set, get),
    ...createUiHydrationActions(set, get),
    ...createUiUpdateActions(set, get),
    ...createUiWslMovedSectionActions(set)
  }) as UISlice
