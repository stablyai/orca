import { describe, expect, it } from 'vitest'

import { parsePlaneIssueLink } from './links'

describe('Plane links', () => {
  it('parses bare Plane work item identifiers', () => {
    expect(parsePlaneIssueLink('aif-8009')).toEqual({
      projectIdentifier: 'AIF',
      sequenceId: 8009,
      identifier: 'AIF-8009'
    })
  })

  it('parses Plane workspace issue URLs', () => {
    expect(
      parsePlaneIssueLink('https://plane.home.usableapps.io/usableapps/issues/aif-8009')
    ).toEqual({
      baseUrl: 'https://plane.home.usableapps.io',
      workspaceSlug: 'usableapps',
      projectIdentifier: 'AIF',
      sequenceId: 8009,
      identifier: 'AIF-8009'
    })
  })

  it('parses Plane workspaces-prefixed issue URLs', () => {
    expect(
      parsePlaneIssueLink('https://plane.example.com/workspaces/acme/issues/eng-12/details')
    ).toEqual({
      baseUrl: 'https://plane.example.com',
      workspaceSlug: 'acme',
      projectIdentifier: 'ENG',
      sequenceId: 12,
      identifier: 'ENG-12'
    })
  })

  it('parses Plane browse work-item URLs', () => {
    expect(parsePlaneIssueLink('https://app.plane.so/acme/browse/eng-12')).toEqual({
      baseUrl: 'https://app.plane.so',
      workspaceSlug: 'acme',
      projectIdentifier: 'ENG',
      sequenceId: 12,
      identifier: 'ENG-12'
    })
  })

  it('rejects Plane browse epic URLs', () => {
    expect(parsePlaneIssueLink('https://app.plane.so/acme/browse/epic/eng-12')).toBeNull()
    expect(parsePlaneIssueLink('https://app.plane.so/acme/browse/epics/eng-12')).toBeNull()
  })

  it('rejects non-web URLs', () => {
    expect(parsePlaneIssueLink('file://plane.example.com/acme/issues/ENG-12')).toBeNull()
  })

  it('rejects web URLs without a Plane issue route', () => {
    expect(parsePlaneIssueLink('https://example.com/AIF-8009')).toBeNull()
  })

  it('rejects unsafe sequence IDs', () => {
    expect(parsePlaneIssueLink('AIF-9007199254740993')).toBeNull()
    expect(parsePlaneIssueLink('AIF-0')).toBeNull()
  })
})
