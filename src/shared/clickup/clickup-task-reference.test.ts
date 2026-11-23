import { expect, it } from 'vitest'
import {
  clickupGitReferenceLabel,
  isClickUpTaskUrl,
  parseClickUpTaskReference
} from './clickup-task-reference'

it('parses task urls, raw ids and custom ids', () => {
  expect(parseClickUpTaskReference('https://app.clickup.com/t/86abc12de')).toEqual({
    kind: 'id',
    id: '86abc12de'
  })
  expect(parseClickUpTaskReference('https://app.clickup.com/t/86abc12de?comment=1')).toEqual({
    kind: 'id',
    id: '86abc12de'
  })
  expect(parseClickUpTaskReference('https://app.clickup.com/t/9001/eng-7')).toEqual({
    kind: 'custom-id',
    customId: 'ENG-7',
    workspaceId: '9001'
  })
  expect(parseClickUpTaskReference('ENG-123')).toEqual({
    kind: 'custom-id',
    customId: 'ENG-123',
    workspaceId: null
  })
  expect(parseClickUpTaskReference('  86abc12de ')).toEqual({ kind: 'id', id: '86abc12de' })
})

it('accepts underscores in custom id prefixes', () => {
  expect(parseClickUpTaskReference('https://app.clickup.com/t/9001/eng_api-7')).toEqual({
    kind: 'custom-id',
    customId: 'ENG_API-7',
    workspaceId: '9001'
  })
  expect(parseClickUpTaskReference('ENG_API-7')).toEqual({
    kind: 'custom-id',
    customId: 'ENG_API-7',
    workspaceId: null
  })
})

it('accepts the short raw ids ClickUp documents', () => {
  expect(parseClickUpTaskReference('9hz')).toEqual({ kind: 'id', id: '9hz' })
  expect(parseClickUpTaskReference('https://app.clickup.com/t/9hz')).toEqual({
    kind: 'id',
    id: '9hz'
  })
})

it('reads a digitless bare token as a raw id so detail, comments and status accept it', () => {
  expect(parseClickUpTaskReference('abcdefg')).toEqual({ kind: 'id', id: 'abcdefg' })
})

it('rejects foreign hosts and non-task paths', () => {
  expect(parseClickUpTaskReference('https://evil.example/t/86abc12de')).toBeNull()
  expect(parseClickUpTaskReference('https://notclickup.com/t/86abc12de')).toBeNull()
  expect(parseClickUpTaskReference('https://app.clickup.com/9001/v/l/6-1-1')).toBeNull()
  expect(parseClickUpTaskReference('login bug')).toBeNull()
  expect(parseClickUpTaskReference('')).toBeNull()
})

it('prefixes only raw task ids for ClickUp Git linking', () => {
  expect(clickupGitReferenceLabel('86abc12de')).toBe('CU-86abc12de')
  expect(clickupGitReferenceLabel('ENG-7')).toBe('ENG-7')
  expect(clickupGitReferenceLabel('CU-86abc12de')).toBe('CU-86abc12de')
  expect(clickupGitReferenceLabel('2x5kz')).toBe('CU-2x5kz')
  expect(clickupGitReferenceLabel('86abc12de3456')).toBe('CU-86abc12de3456')
  expect(clickupGitReferenceLabel('PLAT2-1042')).toBe('PLAT2-1042')
})

it('rejects credential-bearing task urls so callers that refuse credentials never see one', () => {
  const url = 'https://user:secret@app.clickup.com/t/86abc12de'
  expect(isClickUpTaskUrl(url)).toBe(false)
  expect(parseClickUpTaskReference(url)).toBeNull()
})
