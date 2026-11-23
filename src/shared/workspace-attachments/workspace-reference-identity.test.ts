import { expect, it } from 'vitest'
import {
  getWorkspaceReferenceIdentity,
  parseWorkspaceReferenceUrl
} from './workspace-reference-identity'

it('parses ClickUp task URLs into clickup references', () => {
  expect(parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de/?comment=1#top')).toEqual({
    provider: 'clickup',
    type: 'issue',
    number: 0,
    clickupIdentifier: '86abc12de',
    url: 'https://app.clickup.com/t/86abc12de'
  })
  expect(parseWorkspaceReferenceUrl('https://app.clickup.com/t/9001/eng-7')).toEqual({
    provider: 'clickup',
    type: 'issue',
    number: 0,
    clickupIdentifier: 'ENG-7',
    url: 'https://app.clickup.com/t/9001/ENG-7'
  })
})

it('keeps the same identity for a stored ClickUp reference and its URL', () => {
  const parsed = parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de')
  const stored = { ...parsed, identifier: '86abc12de' }
  expect(getWorkspaceReferenceIdentity(stored)).toBe(getWorkspaceReferenceIdentity(parsed))
  expect(JSON.parse(getWorkspaceReferenceIdentity(parsed))[0]).toBe('clickup')
})

it('rejects ClickUp links that carry no task id or belong to another provider', () => {
  expect(() => parseWorkspaceReferenceUrl('https://app.clickup.com/9001/v/l/6-1-1')).toThrow()
  expect(() => parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de', 'jira')).toThrow()
  expect(
    parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de', 'clickup').provider
  ).toBe('clickup')
})
