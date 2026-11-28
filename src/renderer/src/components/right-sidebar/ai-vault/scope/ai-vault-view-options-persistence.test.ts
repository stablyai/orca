import { expect, it } from 'vitest'
import {
  readAiVaultViewOptions,
  toggleAiVaultCollapsedGroup,
  writeAiVaultViewOptions
} from './ai-vault-view-options-persistence'

it('restores collapsed host-qualified groups and remembers when just one is expanded', () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value)
  }
  const local = 'local/project:review'
  const remote = 'ssh-a/project:review'
  const initial = readAiVaultViewOptions(storage)
  writeAiVaultViewOptions({ ...initial, collapsedGroups: [local, remote] }, storage)

  const restored = readAiVaultViewOptions(storage)
  expect(restored.collapsedGroups).toEqual([local, remote])
  const collapsedGroups = [...toggleAiVaultCollapsedGroup(new Set(restored.collapsedGroups), local)]
  writeAiVaultViewOptions({ ...restored, collapsedGroups, sort: 'created' }, storage)

  expect(readAiVaultViewOptions(storage)).toMatchObject({
    collapsedGroups: [remote],
    sort: 'created'
  })
})
