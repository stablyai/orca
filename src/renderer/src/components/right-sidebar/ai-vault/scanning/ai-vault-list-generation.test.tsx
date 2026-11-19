// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AiVaultScanProgress } from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { useAiVaultListGeneration } from './ai-vault-list-generation'
import { AiVaultScanProgressStrip } from './AiVaultScanProgressStrip'

afterEach(cleanup)

it('changes when a list is shown or another list is requested, including a return to an earlier one', () => {
  const { result, rerender } = renderHook(
    ({ revision, key }) => useAiVaultListGeneration(revision, key),
    { initialProps: { revision: 0, key: 'k1' } }
  )
  const first = result.current
  rerender({ revision: 0, key: 'k1' })
  expect(result.current).toBe(first)
  rerender({ revision: 0, key: 'k2' })
  const away = result.current
  expect(away).not.toBe(first)
  rerender({ revision: 0, key: 'k1' })
  expect(result.current).not.toBe(first)
  expect(result.current).not.toBe(away)
  const back = result.current
  rerender({ revision: 1, key: 'k1' })
  expect(result.current).not.toBe(back)
})

const running: AiVaultScanProgress = {
  scanId: 'scan-s',
  stage: 'reading',
  startedAt: 1_700_000_000_000,
  settledAt: null,
  agents: [{ agent: 'codex', files: 12, databases: 0, walking: false }],
  read: { done: 3, total: 10 }
}
const done: AiVaultScanProgress = { ...running, stage: 'finished', settledAt: 1_700_000_005_000 }

function Panel(props: { progress: AiVaultScanProgress; listKey: string; revision: number }) {
  const generation = useAiVaultListGeneration(props.revision, props.listKey)
  return (
    <AiVaultScanProgressStrip progress={props.progress} listPending listGeneration={generation} />
  )
}

it('does not revive a held scan after leaving its list and returning to cached rows', () => {
  const { rerender } = render(<Panel progress={running} listKey="k1" revision={0} />)
  rerender(<Panel progress={done} listKey="k1" revision={0} />)
  expect(screen.getByTitle('Loading sessions: 12 files')).toBeTruthy()
  // Its list is never shown; another list is requested and no scan reports for it.
  rerender(<Panel progress={done} listKey="k2" revision={0} />)
  // Back to the first list: cached rows show, no fresh list has been applied, and the wait continues.
  rerender(<Panel progress={done} listKey="k1" revision={0} />)
  expect(screen.getByTitle('Loading sessions…')).toBeTruthy()
  expect(screen.queryByText(/12 files|\d+:\d\d/)).toBeNull()
})
