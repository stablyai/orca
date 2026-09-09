import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../../shared/github/project-result-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { settingsForProjectRowOwner } from '../slices/github-project-row-owner'
import { settingsForProjectViewCacheKey } from './cache-identity'
import { applyRowPatch, parseSlugAndNumber, rollbackRowIfPresent } from './project-cache'

export const createProjectRowActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  'patchProjectIssueOrPr' | 'patchProjectRowIssueType' | 'patchProjectRowContent'
> => ({
  patchProjectIssueOrPr: async (cacheKey, rowId, updates) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    const { owner, repo, number } = parseSlugAndNumber(previousRow) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate(
            'auto.store.slices.github.87020f6605',
            'Row has no owner/repo/number — cannot patch underlying item'
          )
        }
      }
    }
    // Optimistic content patch.
    const nextContent = { ...previousRow.content }
    if (updates.title !== undefined) {
      nextContent.title = updates.title
    }
    if (updates.body !== undefined) {
      nextContent.body = updates.body
    }
    if (updates.addLabels || updates.removeLabels) {
      const next = new Map(nextContent.labels.map((l) => [l.name, l]))
      for (const name of updates.addLabels ?? []) {
        if (!next.has(name)) {
          next.set(name, { name, color: '808080' })
        }
      }
      for (const name of updates.removeLabels ?? []) {
        next.delete(name)
      }
      nextContent.labels = Array.from(next.values())
    }
    if (updates.addAssignees || updates.removeAssignees) {
      const next = new Map(nextContent.assignees.map((u) => [u.login, u]))
      for (const login of updates.addAssignees ?? []) {
        if (!next.has(login)) {
          next.set(login, { login, name: null, avatarUrl: null })
        }
      }
      for (const login of updates.removeAssignees ?? []) {
        next.delete(login)
      }
      nextContent.assignees = Array.from(next.values())
    }
    const optimisticRow: GitHubProjectRow = { ...previousRow, content: nextContent }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    // Why: labels/assignees go through the issue endpoint for both (GitHub PRs are issues for those); title/body split PR→updatePullRequestBySlug vs issue→updateIssueBySlug.
    let envelope: GitHubProjectMutationResult = { ok: true }
    // Why: slug-only Project rows have no registered Orca repo, so fall back to the view source in the cache key, not the focused host.
    const target = getActiveRuntimeTarget(
      settingsForProjectRowOwner(
        get(),
        owner,
        repo,
        table.project.host,
        settingsForProjectViewCacheKey(get().settings, cacheKey)
      )
    )
    if (
      previousRow.itemType === 'PULL_REQUEST' &&
      (updates.title !== undefined || updates.body !== undefined)
    ) {
      const args = {
        owner,
        repo,
        host: table.project.host,
        number,
        updates: {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.body !== undefined ? { body: updates.body } : {})
        }
      }
      const prRes =
        target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.updatePullRequestBySlug',
              args,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updatePullRequestBySlug(args)
      if (!prRes.ok) {
        envelope = prRes
      }
    }
    if (
      envelope.ok &&
      (updates.addLabels?.length ||
        updates.removeLabels?.length ||
        updates.addAssignees?.length ||
        updates.removeAssignees?.length ||
        (previousRow.itemType === 'ISSUE' &&
          (updates.title !== undefined || updates.body !== undefined)))
    ) {
      const args = {
        owner,
        repo,
        host: table.project.host,
        number,
        updates: {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.body !== undefined ? { body: updates.body } : {}),
          ...(updates.addLabels ? { addLabels: updates.addLabels } : {}),
          ...(updates.removeLabels ? { removeLabels: updates.removeLabels } : {}),
          ...(updates.addAssignees ? { addAssignees: updates.addAssignees } : {}),
          ...(updates.removeAssignees ? { removeAssignees: updates.removeAssignees } : {})
        }
      }
      const issueRes =
        target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.updateIssueBySlug',
              args,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updateIssueBySlug(args)
      if (!issueRes.ok) {
        envelope = issueRes
      }
    }
    if (!envelope.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return envelope
  },

  patchProjectRowIssueType: async (cacheKey, rowId, issueType) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const row = table.rows.find((r) => r.id === rowId)
    if (!row) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    if (row.itemType !== 'ISSUE') {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate(
            'auto.store.slices.github.83f9b126ad',
            'Issue Type can only be set on Issues.'
          )
        }
      }
    }
    const { owner, repo, number } = parseSlugAndNumber(row) ?? {}
    if (!owner || !repo || !number) {
      return {
        ok: false,
        error: {
          type: 'validation_error',
          message: translate('auto.store.slices.github.683a21264b', 'Row has no owner/repo/number.')
        }
      }
    }
    const previousRow = row
    const optimistic: GitHubProjectRow = {
      ...previousRow,
      content: { ...previousRow.content, issueType }
    }
    applyRowPatch(set, cacheKey, rowId, optimistic)
    // Why: slug-only Project rows belong to the host that loaded the view, which may differ from the now-focused host.
    const target = getActiveRuntimeTarget(
      settingsForProjectRowOwner(
        get(),
        owner,
        repo,
        table.project.host,
        settingsForProjectViewCacheKey(get().settings, cacheKey)
      )
    )
    const args = {
      owner,
      repo,
      host: table.project.host,
      number,
      issueTypeId: issueType?.id ?? null
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.updateIssueTypeBySlug',
            args,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateIssueTypeBySlug(args)
    if (!res.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return res
  },

  patchProjectRowContent: (cacheKey, rowId, patch) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return
    }
    const previousRow = table.rows.find((r) => r.id === rowId)
    if (!previousRow) {
      return
    }
    const nextContent = { ...previousRow.content }
    if (patch.title !== undefined) {
      nextContent.title = patch.title
    }
    if (patch.body !== undefined) {
      nextContent.body = patch.body
    }
    if (patch.state !== undefined) {
      // Why: ProjectV2 row.state is GitHub's UPPERCASE enum ('OPEN'|'CLOSED'|'MERGED') but the dialog tracks lowercase; upper-case so the patch matches the canonical row shape.
      nextContent.state = patch.state.toUpperCase()
    }
    if (patch.labels !== undefined) {
      const existingByName = new Map(previousRow.content.labels.map((l) => [l.name, l]))
      nextContent.labels = patch.labels.map(
        (name) => existingByName.get(name) ?? { name, color: '808080' }
      )
    }
    if (patch.assignees !== undefined) {
      const existingByLogin = new Map(previousRow.content.assignees.map((u) => [u.login, u]))
      nextContent.assignees = patch.assignees.map(
        (login) => existingByLogin.get(login) ?? { login, name: null, avatarUrl: null }
      )
    }
    const nextRow: GitHubProjectRow = { ...previousRow, content: nextContent }
    applyRowPatch(set, cacheKey, rowId, nextRow)
  }
})
