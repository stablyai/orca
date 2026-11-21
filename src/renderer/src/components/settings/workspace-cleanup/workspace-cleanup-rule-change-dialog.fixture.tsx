import { useState } from 'react'
import { WorkspaceCleanupKeepSelection } from './workspace-cleanup-keep-selection'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  WorkspaceCleanupRuleChangeDialog,
  type WorkspaceCleanupRuleChangeRequest
} from './workspace-cleanup-rule-change-dialog'
import { cleanupChangeRowKey } from './workspace-cleanup-change-preview'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'
import { RepositoryWorkspaceCleanupSection } from '../repository/workspace-cleanup/RepositoryWorkspaceCleanupSection'

function rows(count: number): WorkspaceCleanupPreviewRow[] {
  return Array.from({ length: count }, (_, index) => ({
    worktreeId: `example::/synthetic/workspace-${index}`,
    instanceId: `instance-${index}`,
    repoId: 'example',
    repoName: 'Example project',
    displayName:
      index === 0
        ? 'Preserve authentication sessions while reconnecting the development environment'
        : `Workspace ${index + 1}`,
    branch: `feature-${index + 1}`,
    path: `/synthetic/workspace-${index}`,
    executionHostId: 'local',
    sizeBytes: 1048576,
    evaluation: { action: 'delete', reason: index % 2 ? 'inactive' : 'merged' }
  }))
}
function request(count = 3): WorkspaceCleanupRuleChangeRequest {
  const list = rows(count)
  return {
    kind: 'enable',
    setting: 'merged',
    projectName: 'Example project',
    rows: [...list.slice(-1), ...list.slice(0, -1)],
    newKeys: new Set([cleanupChangeRowKey(list.at(-1)!)]),
    currentKeys: new Set(list.slice(0, -1).map(cleanupChangeRowKey)),
    selection: new WorkspaceCleanupKeepSelection(list),
    status: null
  }
}
function Example({ value, error }: { value: WorkspaceCleanupRuleChangeRequest; error?: string }) {
  const [current] = useState(value)
  return (
    <div className="h-screen">
      <WorkspaceCleanupRuleChangeDialog
        request={current}
        onCancel={() => {}}
        onConfirm={async () => {}}
        onToggleKeep={(row) => current.selection.toggle(row)}
        error={error}
      />
    </div>
  )
}
export const rule = defineFixture({ width: 640, render: () => <Example value={request(2)} /> })
/** Every match kept: confirming deletes nothing, so the button is the normal one. */
export const allKept = defineFixture({
  width: 640,
  render: () => {
    const value = request(2)
    for (const row of value.rows) {
      value.selection.toggle(row)
    }
    return <Example value={value} />
  }
})
/** A long project name in the title; capture at the main window's 600 px minimum for the narrowest dialog. */
const LONG_PROJECT_NAME = 'Customer onboarding analytics and billing reconciliation service'
export const longProject = defineFixture({
  width: 600,
  render: () => <Example value={{ ...request(2), projectName: LONG_PROJECT_NAME }} />
})
export const longProjectAllKept = defineFixture({
  width: 600,
  render: () => {
    const value = { ...request(2), projectName: LONG_PROJECT_NAME }
    for (const row of value.rows) {
      value.selection.toggle(row)
    }
    return <Example value={value} />
  }
})
export const days = defineFixture({
  width: 640,
  render: () => <Example value={{ ...request(), kind: 'change', setting: 'inactive' }} />
})
export const inherit = defineFixture({
  width: 640,
  render: () => <Example value={{ ...request(), kind: 'inherit', setting: 'mode' }} />
})
export const allNew = defineFixture({
  width: 360,
  render: () => (
    <Example value={{ ...request(), rows: rows(3), newKeys: new Set(), currentKeys: new Set() }} />
  )
})
export const refreshedMixedKeep = defineFixture({
  width: 360,
  render: () => {
    const value = request(),
      list = rows(3)
    list[0].evaluation = { action: 'delete', reason: 'inactive' }
    list[1].evaluation = { action: 'delete', reason: 'merged' }
    list[2] = {
      ...list[2],
      displayName: 'refresh-added-docs',
      evaluation: { action: 'delete', reason: 'merged' }
    }
    return (
      <Example
        value={{
          ...value,
          rows: [list[2], list[0], list[1]],
          newKeys: new Set([cleanupChangeRowKey(list[2])]),
          currentKeys: new Set([cleanupChangeRowKey(list[0])]),
          selection: new WorkspaceCleanupKeepSelection(list, [list[0]]),
          status: { added: 1, deleted: [] }
        }}
      />
    )
  }
})
export const keptDeleted = defineFixture({
  width: 360,
  render: () => (
    <Example
      value={{ ...request(), status: { added: 1, deleted: ['Workspace removed elsewhere'] } }}
    />
  )
})
export const pinError = defineFixture({
  width: 360,
  render: () => (
    <Example
      value={{ ...request(), selection: new WorkspaceCleanupKeepSelection(rows(3), [rows(3)[0]]) }}
      error="Couldn't keep Workspace 1. Rule not changed."
    />
  )
})
export const saveError = defineFixture({
  width: 360,
  render: () => <Example value={request()} error="Couldn't save. Rule not changed." />
})
export const many = defineFixture({
  width: 640,
  render: () => (
    <Example
      value={{ ...request(200), rows: rows(200), newKeys: new Set(), currentKeys: new Set() }}
    />
  )
})
export const thousand = defineFixture({
  width: 640,
  render: () => (
    <Example
      value={{ ...request(1000), rows: rows(1000), newKeys: new Set(), currentKeys: new Set() }}
    />
  )
})
async function reachLastRow() {
  const list = document.querySelector<HTMLElement>('[role="dialog"] [role="list"]')!
  list.focus()
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}
export const manyEnd = defineFixture({ ...many, interact: reachLastRow })
export const thousandEnd = defineFixture({ ...thousand, interact: reachLastRow })
export const german = defineFixture({
  ...refreshedMixedKeep,
  interact: async () => {
    const { setRendererUiLanguage } = await import('@/i18n/i18n')
    await setRendererUiLanguage('de')
  }
})
export const chinese = defineFixture({
  ...refreshedMixedKeep,
  interact: async () => {
    const { setRendererUiLanguage } = await import('@/i18n/i18n')
    await setRendererUiLanguage('zh')
  }
})
const settings = {
  ...getDefaultSettings('/synthetic'),
  machineName: 'Build Mac Studio',
  workspaceCleanupPolicy: {
    ...getDefaultWorkspaceCleanupRules(),
    inactive: { enabled: true, afterDays: 90, action: 'delete' as const }
  }
}
const repo = {
  id: 'example',
  path: '/synthetic/project',
  displayName: 'Example project',
  addedAt: 1,
  badgeColor: 'gray',
  workspaceCleanupPolicy: { mode: 'custom' as const, rules: settings.workspaceCleanupPolicy }
}
function oldHost() {
  window.api.runtime.call = async ({ method }) =>
    method === 'workspaceCleanup.report'
      ? {
          id: 'fixture',
          _meta: { runtimeId: 'fixture' },
          ok: true,
          result: { runs: [], running: false, nextRunAt: null }
        }
      : { id: 'fixture', ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
}
function OldProjectExample() {
  const [current, setCurrent] = useState<Repo>(repo)
  return (
    <RepositoryWorkspaceCleanupSection
      repo={current}
      forceVisible
      updateRepo={async (_, updates) => {
        setCurrent((previous) => ({
          ...previous,
          workspaceCleanupPolicy: updates.workspaceCleanupPolicy ?? undefined
        }))
        return true
      }}
    />
  )
}
export const oldProject = defineFixture({
  width: 360,
  store: { settings, repos: [repo], settingsSearchQuery: '' },
  setup: oldHost,
  render: () => <OldProjectExample />
})
export const oldGlobal = defineFixture({
  width: 360,
  store: { settings, settingsSearchQuery: '' },
  setup: oldHost,
  render: () => (
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={settings}
      updateSettings={() => {}}
    />
  )
})
function previewHost(fail: boolean) {
  window.api.runtime.call = async ({ method }) => {
    if (method === 'workspaceCleanup.previewChange') {
      if (fail) {
        return {
          id: 'fixture',
          ok: false,
          error: { code: 'unavailable', message: 'Preview unavailable' }
        }
      }
      return new Promise(() => {})
    }
    if (method === 'workspaceCleanup.policyState') {
      return {
        id: 'fixture',
        ok: true,
        _meta: { runtimeId: 'fixture' },
        result: {
          protocol: 3,
          expiresAt: Date.now() + 60_000,
          state: {
            repoId: 'example',
            rules: settings.workspaceCleanupPolicy,
            projects: [{ id: repo.id, hostId: 'local', policy: repo.workspaceCleanupPolicy }]
          }
        }
      }
    }
    return {
      id: 'fixture',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    }
  }
}
async function editRule(frame: HTMLElement) {
  const control = frame.querySelector<HTMLButtonElement>('[role="switch"]')!
  if (control.getAttribute('aria-disabled') === 'true') {
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (control.getAttribute('aria-disabled') !== 'true') {
          observer.disconnect()
          resolve()
        }
      })
      observer.observe(control, { attributes: true })
    })
  }
  control.click()
}
export const checkingProject = defineFixture({
  width: 360,
  store: { settings, repos: [repo], settingsSearchQuery: '' },
  setup: () => previewHost(false),
  interact: editRule,
  render: () => (
    <RepositoryWorkspaceCleanupSection repo={repo} forceVisible updateRepo={async () => true} />
  )
})
export const previewError = defineFixture({
  width: 360,
  store: { settings, repos: [repo], settingsSearchQuery: '' },
  setup: () => previewHost(true),
  interact: editRule,
  render: () => (
    <RepositoryWorkspaceCleanupSection repo={repo} forceVisible updateRepo={async () => true} />
  )
})

export const advancedPreviewError = defineFixture({
  ...previewError,
  interact: async (frame) => {
    const waitFor = async (ready: () => boolean) => {
      if (ready()) {
        return
      }
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (ready()) {
            observer.disconnect()
            resolve()
          }
        })
        observer.observe(frame, { subtree: true, attributes: true, childList: true })
      })
    }
    await waitFor(
      () => frame.querySelector('[role="switch"]')?.getAttribute('aria-disabled') === 'false'
    )
    const advanced = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Advanced')
    )!
    advanced.click()
    await waitFor(() => frame.querySelectorAll('[role="switch"]').length > 3)
    frame.querySelectorAll<HTMLButtonElement>('[role="switch"]')[3].click()
    await waitFor(
      () =>
        frame.querySelector('[role="switch"]')?.getAttribute('aria-disabled') === 'false' &&
        (advanced.getAttribute('aria-expanded') === 'false' ||
          frame.querySelector('[role="alert"]') !== null)
    )
  }
})
