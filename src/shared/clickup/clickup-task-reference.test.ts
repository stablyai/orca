import { expect, it } from 'vitest'
import { clickupGitReferenceLabel, parseClickUpTaskReference } from './clickup-task-reference'

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
