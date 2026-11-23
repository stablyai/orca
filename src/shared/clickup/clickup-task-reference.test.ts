import { expect, it } from 'vitest'
import { parseClickUpTaskReference } from './clickup-task-reference'

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
