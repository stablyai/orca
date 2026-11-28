// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { UI_STORAGE_KEY, writeJson } from '../web-storage'
import { mergeWebUIState, readLocalWebUIState } from './web-ui-state'

it('starts a legacy browser cache at its rendered scale and restores subsequent edits', () => {
  writeJson(UI_STORAGE_KEY, { uiZoomLevel: 1.5 })
  const migrated = readLocalWebUIState()
  expect(migrated).toMatchObject({ uiZoomLevel: 0, sidebarZoomLevel: 0 })

  writeJson(UI_STORAGE_KEY, mergeWebUIState(migrated, { uiZoomLevel: 0.5 }))
  expect(readLocalWebUIState()).toMatchObject({ uiZoomLevel: 0.5, sidebarZoomLevel: 0 })
})
