import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BranchPicker } from './BranchPicker'

function installRuntime(switchError: string | null, warning?: string) {
  window.api.runtime.call = (async ({ method }: { method: string }) => {
    if (method === 'git.localBranches') {
      return { id: method, ok: true, result: { current: 'main', branches: ['main', 'feature'] } }
    }
    if (method === 'repo.searchRefs') {
      return { id: method, ok: true, result: { refs: [], truncated: false } }
    }
    return switchError
      ? { id: method, ok: false, error: { code: 'runtime_error', message: switchError } }
      : { id: method, ok: true, result: { ok: true, branch: 'feature', warning } }
  }) as typeof window.api.runtime.call
}

function Picker({ blocker }: { blocker: string | null }) {
  return (
    <div className="h-72 p-2">
      <BranchPicker
        branch="main"
        blocker={blocker}
        dirtyOnlyBlocker={blocker !== null}
        context={{ target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' }}
        repoId="repo"
        hostId="local"
        hostLabel="This computer"
        workspaces={new Map()}
        onOpenWorkspace={() => {}}
        onSwitched={(warning) => warning && toast.warning(warning)}
      />
      <Toaster position="top-left" closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

async function openPicker(frame: HTMLElement) {
  frame.querySelector<HTMLButtonElement>('button[aria-label^="Switch branch"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

async function pickFeature(frame: HTMLElement) {
  await openPicker(frame)
  const row = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
    (item) => item.textContent === 'feature'
  )
  row?.click()
  await new Promise((resolve) => setTimeout(resolve, 800))
}

export const dirty = defineFixture({
  width: 420,
  setup: () => installRuntime(null),
  render: () => <Picker blocker="Commit or discard 2 changed files before switching branches." />,
  interact: openPicker
})

export const agentRefused = defineFixture({
  width: 420,
  setup: () =>
    installRuntime(
      'Claude is working in this workspace. Wait for it to finish or stop it, then switch branches.'
    ),
  render: () => <Picker blocker={null} />,
  interact: pickFeature
})

export const hookFailed = defineFixture({
  width: 420,
  setup: () =>
    installRuntime(
      null,
      'Switched to feature. A git hook in this repository failed afterwards and said: hook check failed. The switch itself worked.'
    ),
  render: () => <Picker blocker={null} />,
  interact: pickFeature
})

export const agentWorking = defineFixture({
  width: 420,
  setup: () => installRuntime(null),
  render: () => (
    <Picker blocker="An agent is working in this workspace. Switch branches after it finishes." />
  ),
  interact: openPicker
})
