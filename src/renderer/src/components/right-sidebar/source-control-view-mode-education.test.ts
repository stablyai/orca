import { describe, expect, it } from 'vitest'
import {
  createSourceControlViewModeEducationChoiceUpdate,
  createSourceControlViewModeEducationDismissUpdate,
  shouldShowSourceControlViewModeEducation
} from './source-control-view-mode-education'

describe('source-control view mode education helpers', () => {
  it('shows only while settings have an undismissed education flag', () => {
    expect(shouldShowSourceControlViewModeEducation(null)).toBe(false)
    expect(shouldShowSourceControlViewModeEducation(undefined)).toBe(false)
    expect(
      shouldShowSourceControlViewModeEducation({
        sourceControlViewModeEducationDismissed: false
      })
    ).toBe(true)
    expect(
      shouldShowSourceControlViewModeEducation({
        sourceControlViewModeEducationDismissed: true
      })
    ).toBe(false)
  })

  it('persists mode choices with the dismissal flag', () => {
    expect(createSourceControlViewModeEducationChoiceUpdate('tree')).toEqual({
      sourceControlViewMode: 'tree',
      sourceControlViewModeEducationDismissed: true
    })
    expect(createSourceControlViewModeEducationChoiceUpdate('list')).toEqual({
      sourceControlViewMode: 'list',
      sourceControlViewModeEducationDismissed: true
    })
  })

  it('persists dismissal without changing the current mode', () => {
    expect(createSourceControlViewModeEducationDismissUpdate()).toEqual({
      sourceControlViewModeEducationDismissed: true
    })
  })
})
