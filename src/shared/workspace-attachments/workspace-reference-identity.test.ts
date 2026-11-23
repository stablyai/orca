import { expect, it } from 'vitest'
import {
  getProvenWorkspaceReferenceIdentity,
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

it('proves a stored ClickUp reference only when its identifier is the one its URL names', () => {
  const url = 'https://app.clickup.com/t/86abc12de'
  const task = { provider: 'clickup', type: 'issue', number: 0, url } as const
  const proven = getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86abc12de' })

  expect(proven).toBeDefined()
  expect(
    getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86different' })
  ).toBeUndefined()
  expect(getProvenWorkspaceReferenceIdentity({ ...task })).toBeUndefined()
})

it('does not give two ClickUp references with different identifiers the same identity', () => {
  const url = 'https://app.clickup.com/t/86abc12de'
  const task = { provider: 'clickup', type: 'issue', number: 0, url } as const

  expect(getWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86different' })).not.toBe(
    getWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86abc12de' })
  )
})

it('proves a custom-id ClickUp reference stored with its raw-id task URL', () => {
  const stored = {
    provider: 'clickup',
    type: 'issue',
    number: 0,
    url: 'https://app.clickup.com/t/86abc123',
    clickupIdentifier: 'ENG-7'
  } as const

  expect(getProvenWorkspaceReferenceIdentity(stored)).toBe(
    getWorkspaceReferenceIdentity(parseWorkspaceReferenceUrl(stored.url))
  )
})

it('keeps the identity of a reference saved with an identifier the parser does not accept', () => {
  const task = {
    provider: 'clickup',
    type: 'issue',
    number: 0,
    url: 'https://app.clickup.com/t/86abc12de'
  } as const

  expect(getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: 'A-7' })).toBe(
    getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86abc12de' })
  )
  expect(
    getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86different' })
  ).toBeUndefined()
})

it('compares a custom-id ClickUp URL with the stored custom id regardless of case', () => {
  const url = 'https://app.clickup.com/t/9001/eng-7'
  const task = { provider: 'clickup', type: 'issue', number: 0, url } as const

  expect(getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: 'ENG-7' })).toBeDefined()
  expect(
    getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: 'ENG-8' })
  ).toBeUndefined()
  expect(
    getProvenWorkspaceReferenceIdentity({ ...task, clickupIdentifier: '86abc12de' })
  ).toBeUndefined()
})

it('rejects ClickUp links that carry no task id or belong to another provider', () => {
  expect(() => parseWorkspaceReferenceUrl('https://app.clickup.com/9001/v/l/6-1-1')).toThrow()
  expect(() => parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de', 'jira')).toThrow()
  expect(
    parseWorkspaceReferenceUrl('https://app.clickup.com/t/86abc12de', 'clickup').provider
  ).toBe('clickup')
})
