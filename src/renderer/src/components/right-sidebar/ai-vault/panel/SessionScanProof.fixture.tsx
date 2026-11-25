import '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultScanProgress } from '../../../../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '../session-list/ai-vault-session-limit'
import { cacheAiVaultSessionList } from '../scanning/ai-vault-session-list-request'
import { invalidateAiVaultSessionResults } from '../scanning/ai-vault-session-result-cache'
import { AiVaultScanProgressStrip } from '../scanning/AiVaultScanProgressStrip'
import AiVaultPanel from './AiVaultPanel'

const remote = toRuntimeExecutionHostId('seeded-history')
const empty: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-07-01T00:00:00.000Z' }
const row: AiVaultSession = {
  id: 'seeded-garden',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'seeded-garden',
  title: 'Plan a demo garden',
  cwd: '/demo/garden',
  branch: null,
  model: null,
  filePath: '/demo/history/garden.jsonl',
  codexHome: null,
  createdAt: empty.scannedAt,
  updatedAt: empty.scannedAt,
  modifiedAt: empty.scannedAt,
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'seeded-garden',
  subagent: null
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error('Seeded history state did not settle')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

type Step = 'wait' | 'settled' | 'retry'
function panelFixture(host: ExecutionHostId, populated: boolean, step: Step = 'wait') {
  const workspace = makeFolderWorkspace({
    id: `seeded-${host}`,
    name: 'Demo garden',
    executionHostId: host,
    folderPath: '/demo/garden'
  })
  const result = { ...empty, sessions: populated ? [{ ...row, executionHostId: host }] : [] }
  const requests: {
    resolve: (result: AiVaultListResult) => void
    reject: (error: Error) => void
  }[] = []
  let focus = () => {}
  return defineFixture({
    width: 382,
    store: { folderWorkspaces: [workspace], activeOrcaProfileId: 'seeded-session-proof' },
    setup: () => {
      requests.length = 0
      window.localStorage.removeItem('orca.aiVault.viewOptions.v1')
      if (step === 'retry') {
        invalidateAiVaultSessionResults(host)
      } else {
        cacheAiVaultSessionList(
          {
            scopePaths: [],
            executionHostScope: host,
            sessionLimit: DEFAULT_AI_VAULT_SESSION_LIMIT
          },
          result,
          { replaceHostEntries: true }
        )
      }
      window.api.aiVault = {
        ...window.api.aiVault,
        listSessions: async (args) => {
          if (args?.executionHostScope !== host) {
            throw new Error('Wrong seeded host requested')
          }
          return new Promise<AiVaultListResult>((resolve, reject) =>
            requests.push({ resolve, reject })
          )
        },
        cancelListSessions: async () => {},
        getScanProgress: async () => null,
        onScanProgress: () => () => {},
        onWindowFocused: (callback) => {
          focus = callback
          return () => {}
        }
      }
    },
    render: () => (
      <div className="h-[520px] @container/ai-vault border border-sidebar-border bg-sidebar">
        <AiVaultPanel
          workspace={{ worktreeId: folderWorkspaceKey(workspace.id), executionHostId: host }}
          initialQuery="garden"
          initialAgents={['codex']}
        />
      </div>
    ),
    interact: async (frame) => {
      await until(() => requests.length === 1)
      if (step === 'settled') {
        requests[0].resolve(result)
        await until(() => frame.textContent?.includes('No agent sessions found') === true)
        if (frame.textContent?.includes('Session list loading')) {
          throw new Error('Foreground note survived settlement')
        }
        if (frame.querySelector('[aria-busy="true"]')) {
          throw new Error('Loader survived settlement')
        }
      } else if (step === 'retry') {
        requests[0].reject(new Error('Seeded host unavailable'))
        await until(() => frame.textContent?.includes('Seeded host unavailable') === true)
        focus()
        await until(() => requests.length === 2)
        if (frame.textContent?.includes('Session list loading')) {
          throw new Error('Background retry revived foreground note')
        }
      } else {
        await until(() => frame.textContent?.includes('Session list loading') === true)
        if (!populated && frame.textContent?.includes('No agent sessions found')) {
          throw new Error('Empty cache bypassed loader')
        }
        if (!populated && frame.querySelectorAll('[aria-busy="true"]').length !== 1) {
          throw new Error('Empty cache lacks one neutral loader')
        }
        if (populated && !frame.textContent?.includes('Loading sessions')) {
          throw new Error('Nonempty wait lacks neutral strip')
        }
      }
    }
  })
}

export const localEmptyWait = panelFixture('local', false)
export const remoteEmptyWait = panelFixture(remote, false)
export const localEmptySettled = panelFixture('local', false, 'settled')
export const remoteEmptySettled = panelFixture(remote, false, 'settled')
export const localNonemptyWait = panelFixture('local', true)
export const remoteNonemptyWait = panelFixture(remote, true)
export const localBackgroundRetry = panelFixture('local', false, 'retry')
export const remoteBackgroundRetry = panelFixture(remote, false, 'retry')

function TerminalStrip(): React.JSX.Element {
  const [phase, setPhase] = useState(0)
  const [capturedAt] = useState(() => Date.now())
  const finished = phase > 0
  const progress: AiVaultScanProgress = {
    scanId: 'seeded-first-scan',
    stage: finished ? 'finished' : 'reading',
    startedAt: capturedAt - 42_000,
    settledAt: finished ? capturedAt : null,
    agents: [
      {
        agent: 'codex',
        files: 50_000,
        databases: 0,
        walking: false,
        read: { done: 50_000, total: 50_000 }
      }
    ],
    read: { done: 50_000, total: 50_000 }
  }
  return (
    <div className="@container/ai-vault border border-sidebar-border bg-sidebar">
      <div className="p-3 text-xs">Seeded same-key retry after terminal replacement</div>
      <button hidden data-next onClick={() => setPhase((value) => value + 1)} />
      <AiVaultScanProgressStrip
        progress={progress}
        active={!finished}
        listPending={phase !== 2}
        listGeneration="same-key"
      />
    </div>
  )
}

export const terminalSameKeyRetry = defineFixture({
  width: 382,
  render: () => <TerminalStrip />,
  interact: async (frame) => {
    const next = frame.querySelector<HTMLButtonElement>('[data-next]')
    for (let phase = 0; phase < 3; phase += 1) {
      next?.click()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      if (phase === 0 && !frame.textContent?.includes('50,000')) {
        throw new Error('Legitimate first scan hold lost its details')
      }
    }
    await until(() => frame.textContent?.includes('Loading sessions') === true)
    if (frame.textContent?.includes('50,000') || frame.querySelector('[role="list"]')) {
      throw new Error('Old scan details survived terminal retry')
    }
    if (frame.querySelector('[data-slot="collapsible-trigger"]')) {
      throw new Error('Neutral wait offers an empty disclosure')
    }
  }
})
