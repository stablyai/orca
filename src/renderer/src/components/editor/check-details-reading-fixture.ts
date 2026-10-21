import { vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { OpenFile } from '@/store/slices/editor'
import type {
  PRCheckDetail,
  PRCheckJob,
  PRCheckRunDetails
} from '../../../../shared/github/check-types'
import { createCheckDetailsReadingOwner } from './check-details-reading-owner'
import {
  checkJobIdentities,
  checkLogDigest,
  checkReadingLogKey
} from './check-details-reading-cache'

export const readingCheck: PRCheckDetail = {
  name: 'verify',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  checkRunId: 42
}
export function readingDetails(
  text: string | null = 'prefix\nError: synthetic diagnostic\n at test.ts:1:2',
  logState?: PRCheckJob['logState']
): PRCheckRunDetails {
  return {
    ...readingCheck,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
    text: null,
    annotations: [],
    jobs: [
      {
        id: 7,
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        startedAt: null,
        completedAt: null,
        logTail: text,
        ...(logState ? { logState } : {}),
        steps: []
      }
    ]
  }
}
export function readingFile(details = readingDetails()): OpenFile {
  return {
    id: 'wt::check-details::check-run:42',
    filePath: 'wt::check-details::check-run:42',
    relativePath: 'verify',
    worktreeId: 'wt',
    language: 'plaintext',
    isDirty: false,
    mode: 'check-details',
    checkRunDetails: {
      contextKey: 'context',
      check: readingCheck,
      details,
      loading: false,
      error: null
    }
  }
}
export function readingFixture(scope = 'pane') {
  const file = readingFile()
  const store = createStore(() => ({ openFiles: [file], unrelated: 0 }))
  const owner = createCheckDetailsReadingOwner(store, file.id, scope, 'context')
  const identity = checkJobIdentities(file.checkRunDetails?.details?.jobs ?? [])[0].identity
  const text = file.checkRunDetails?.details?.jobs[0].logTail ?? ''
  return {
    store,
    file,
    owner,
    identity,
    text,
    logKey: checkReadingLogKey(owner.key, identity, checkLogDigest(text))
  }
}
export function measuredReadingNode(text = '', height = 200): HTMLPreElement {
  const node = document.createElement('pre')
  node.textContent = text
  Object.defineProperties(node, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: 2000 }
  })
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, node.clientWidth, node.clientHeight)
  )
  document.body.append(node)
  return node
}
