import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CreateFromPicker } from './CreateFromPicker'

const repo = {
  id: 'branch-snapshot-fixture',
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '',
  addedAt: 0
}
export const collidingBranches = defineFixture({
  width: 380,
  setup: () => {
    window.api.repos.getBaseRefDefault = async () => ({
      defaultBaseRef: 'origin/main',
      remoteCount: 1
    })
    window.api.repos.searchBaseRefs = async () => [
      'refs/heads/origin/main',
      'refs/remotes/origin/main',
      'refs/heads/feature/a-long-branch-name-for-review'
    ]
  },
  render: () => (
    <div className="min-h-72 p-4">
      <CreateFromPicker
        repoId={repo.id}
        repoMap={new Map([[repo.id, repo]])}
        worktrees={[]}
        value=""
        onValueChange={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
    await new Promise<void>((resolve, reject) => {
      if (document.querySelectorAll('[cmdk-item]').length >= 3) {
        return resolve()
      }
      const timeout = setTimeout(() => {
        observer.disconnect()
        reject(new Error('Branch fixture did not load'))
      }, 5000)
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll('[cmdk-item]').length >= 3) {
          observer.disconnect()
          clearTimeout(timeout)
          resolve()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  }
})

function RequiredBaseline() {
  const [value, setValue] = useState('')
  return (
    <div className="min-h-72 space-y-2 p-4">
      <p className="text-xs text-muted-foreground">Baseline (required)</p>
      <CreateFromPicker
        repoId={repo.id}
        repoMap={new Map([[repo.id, { ...repo, worktreeBaseRef: 'refs/remotes/origin/main' }]])}
        worktrees={[]}
        value={value}
        requireExplicitSelection
        onValueChange={setValue}
      />
    </div>
  )
}

export const requiredBaseline = defineFixture({
  width: 380,
  setup: collidingBranches.setup,
  render: () => <RequiredBaseline />
})

export const requiredDefaultSelected = defineFixture({
  ...requiredBaseline,
  interact: async (frame) => {
    await collidingBranches.interact?.(frame)
    const defaultRow = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
      (row) => row.textContent?.includes('(default)')
    )
    if (!defaultRow) {
      throw new Error('Default branch is missing')
    }
    defaultRow.click()
  }
})
