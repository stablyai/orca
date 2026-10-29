import type { Page } from '@stablyai/playwright-test'
import { leafIdsInOrder } from './workspace-layout-oracle-model'
import { readWorkspaceLayoutStreamFrame } from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'

/** Terminal tab id → its pane ids in tree order, in tab-bar order. */
export type TerminalLayout = [tabId: string, paneIds: string[]][]

/** What main holds for the workspace, read from a stream of the test's own. */
export async function readMainLayout(page: Page, worktreeId: string): Promise<TerminalLayout> {
  const raw = await page.evaluate(
    (id) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('main sent no layout snapshot')), 10_000)
        let handle: { unsubscribe: () => void } | null = null
        let snapshot: unknown
        const finish = (): void => {
          if (handle && snapshot !== undefined) {
            clearTimeout(timer)
            handle.unsubscribe()
            resolve(snapshot)
          }
        }
        void window.api.runtime
          .subscribe({ method: 'layout.subscribe', params: { workspaces: [id] } }, (response) => {
            if (snapshot === undefined && response.ok) {
              snapshot = response.result
              finish()
            }
          })
          .then((opened) => {
            handle = opened
            finish()
          }, reject)
      }),
    worktreeId
  )
  const frame = readWorkspaceLayoutStreamFrame(raw)
  if (frame?.type !== 'snapshot') {
    throw new Error(
      `layout.subscribe opened with no snapshot: ${JSON.stringify(raw).slice(0, 300)}`
    )
  }
  const layout = frame.workspaces.find((entry) => entry.key === worktreeId)?.layout
  return (layout?.tabs ?? [])
    .filter((tab) => tab.kind === 'terminal')
    .map((tab) => [tab.entityId, leafIdsInOrder(tab.terminal?.root)])
}
