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
