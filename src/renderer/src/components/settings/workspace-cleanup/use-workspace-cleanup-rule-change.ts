import { workspaceCleanupChangeMessage } from './workspace-cleanup-change-messages'
import { useWorkspaceCleanupChangeFocus } from './use-workspace-cleanup-change-focus'
import {
  confirmWorkspaceCleanupChange,
  previewCleanupPolicyChange
} from './workspace-cleanup-change-confirmation'
import { createWorkspaceCleanupPolicyWrite } from './workspace-cleanup-policy-client'
// @protected-copy scope=file
import { useWorkspaceCleanupPolicyOwner } from './use-workspace-cleanup-policy-owner'
import {
  proposedCleanupPolicy,
  cleanupPolicyOnlyKeepsMore,
  type CleanupChangeIntent
} from './workspace-cleanup-rule-change-intent'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyRead
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { WorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupPreviewRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { createCleanupChangeRequest, toggleCleanupKeep } from './workspace-cleanup-change-preview'
import type { WorkspaceCleanupRuleChangeRequest } from './workspace-cleanup-rule-change-dialog'

export function useWorkspaceCleanupRuleChange({
  owner,
  repoId = null,
  projectName,
  legacyOff,
  onSavedPreview
}: {
  owner: RuntimeClientTarget
  repoId?: string | null
  projectName?: string
  legacyOff?: () => void | Promise<boolean>
  onSavedPreview?: (rules: WorkspaceCleanupRules, preview: WorkspaceCleanupPreview) => void
}) {
  const t = useTranslate()
  const { read, capability, adopt, readLatest, generation, scopeKey, reload } =
    useWorkspaceCleanupPolicyOwner(owner, repoId)
  const [pending, setPending] = useState<
    (WorkspaceCleanupRuleChangeRequest & { intent: CleanupChangeIntent }) | null
  >(null)
  const [checking, setChecking] = useState<CleanupChangeIntent['setting'] | null>(null)
  const [saving, setSaving] = useState(false)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorSetting, setErrorSetting] = useState<CleanupChangeIntent['setting'] | null>(null)
  const lastIntent = useRef<CleanupChangeIntent | null>(null)
  const [unsavedChanges, setUnsavedChanges] = useState(0)
  const busy = useRef(false)
  const confirming = useRef(false)
  const focus = useWorkspaceCleanupChangeFocus(scopeKey)
  const unresolved = useRef<(() => Promise<void>) | null>(null)
  useLayoutEffect(() => {
    busy.current = false
    confirming.current = false
    unresolved.current = null
    lastIntent.current = null
  }, [scopeKey])
  const [stateScope, setStateScope] = useState(scopeKey)
  if (stateScope !== scopeKey) {
    setStateScope(scopeKey)
    setErrorSetting(null)
    setPending(null)
    setError(null)
    setChecking(null)
    setSaving(false)
    setSettling(false)
  }
  const active = (token: number) => generation.current === token
  const finish = (token: number, reset = false) => {
    if (!active(token)) {
      return
    }
    busy.current = false
    confirming.current = false
    setChecking(null)
    setSaving(false)
    if (reset) {
      setUnsavedChanges((value) => value + 1)
    }
    requestAnimationFrame(() => {
      if (active(token)) {
        focus.restore()
      }
    })
  }
  const commit = async (
    change: WorkspaceCleanupPolicyChange,
    latest: WorkspaceCleanupPolicyRead,
    token: number,
    preview?: WorkspaceCleanupPreview
  ) => {
    if (!active(token)) {
      return
    }
    setSaving(true)
    const write = createWorkspaceCleanupPolicyWrite(owner, change, latest)
    const adoptSavedPreview = (saved: WorkspaceCleanupPolicyRead) => {
      if (
        preview &&
        change.scope === 'global' &&
        JSON.stringify(saved.state) === JSON.stringify({ ...latest.state, rules: change.rules })
      ) {
        onSavedPreview?.(change.rules, preview)
      }
    }
    const settle = async () => {
      const result = await write.settle()
      const saved = result.read
      if (!active(token)) {
        return
      }
      if (result.outcome === 'saved') {
        adoptSavedPreview(saved)
        setPending(null)
        setError(null)
      } else if (result.outcome === 'failed') {
        setError(workspaceCleanupChangeMessage('save', t))
      } else {
        setError(workspaceCleanupChangeMessage('conflict', t))
      }
      adopt(saved)
      unresolved.current = null
      setSettling(false)
      finish(token, true)
    }
    try {
      await write.send()
      if (!active(token)) {
        return
      }
      const refreshed = await readLatest()
      if (!active(token)) {
        return
      }
      adoptSavedPreview(refreshed)
      adopt(refreshed)
      setPending(null)
      setError(null)
      finish(token)
    } catch {
      if (!active(token)) {
        return
      }
      setError(workspaceCleanupChangeMessage('checking', t))
      setSettling(true)
      unresolved.current = settle
      try {
        await settle()
      } catch {
        setSaving(false)
      }
    }
  }
  const requestChange = async (intent: CleanupChangeIntent) => {
    if (busy.current || unresolved.current) {
      return
    }
    focus.capture()
    lastIntent.current = intent
    setErrorSetting(intent.setting)
    setError(null)
    const token = generation.current
    if (capability !== 'ready') {
      if (intent.mode === 'off' && legacyOff) {
        busy.current = true
        setChecking('mode')
        try {
          const saved = await legacyOff()
          if (active(token) && saved === false) {
            setError(workspaceCleanupChangeMessage('checking', t))
          }
        } catch {
          if (active(token)) {
            setError(workspaceCleanupChangeMessage('checking', t))
          }
        }
        finish(token, true)
      } else {
        finish(token, true)
      }
      return
    }
    busy.current = true
    setChecking(intent.setting)
    try {
      const latest = await readLatest()
      if (!active(token)) {
        return
      }
      const next = proposedCleanupPolicy(latest, intent)
      if (intent.kind !== 'disable-ignored-files' && cleanupPolicyOnlyKeepsMore(latest, next)) {
        await commit(next, latest, token)
        return
      }
      const comparison = await previewCleanupPolicyChange(
        owner,
        next,
        intent.kind === 'disable-ignored-files' ? latest : undefined
      )
      if (!active(token)) {
        return
      }
      const request = createCleanupChangeRequest(comparison, intent, projectName)
      if (!request) {
        await commit(next, comparison.read, token, comparison.next)
        return
      }
      setPending(request)
      setChecking(null)
    } catch {
      if (active(token)) {
        setError(workspaceCleanupChangeMessage('preview', t))
        finish(token, true)
      }
    }
  }
  const cancel = () => {
    setPending(null)
    finish(generation.current, true)
  }
  const confirm = async () => {
    if (!pending || confirming.current || unresolved.current) {
      return
    }
    confirming.current = true
    const token = generation.current
    setSaving(true)
    setError(null)
    try {
      const result = await confirmWorkspaceCleanupChange(owner, pending, repoId, () =>
        active(token)
      )
      if (!active(token) || result.kind === 'cancelled') {
        return
      }
      if (result.kind === 'refresh') {
        setPending({ ...result.request, intent: pending.intent })
        confirming.current = false
        setSaving(false)
        return
      }
      if (result.kind === 'pin-failed') {
        setError(
          t(
            'components.settings.workspaceCleanup.change.pinFailed',
            "Couldn't keep {{name}}. Rule not changed.",
            { name: result.row.displayName }
          )
        )
        confirming.current = false
        setSaving(false)
        return
      }
      await commit(result.change, result.read, token, result.preview)
    } catch {
      if (active(token)) {
        setError(workspaceCleanupChangeMessage('preview', t))
        confirming.current = false
        setSaving(false)
      }
    }
  }
  return {
    read,
    capability,
    pending,
    checking,
    saving,
    settling,
    errorSetting,
    error: error ?? (capability === 'error' ? workspaceCleanupChangeMessage('preview', t) : null),
    unsavedChanges,
    guarded: capability !== 'ready' || checking !== null || pending !== null || saving || settling,
    rememberControl: focus.remember,
    requestChange: (intent: CleanupChangeIntent) => void requestChange(intent),
    cancel,
    confirm,
    retry: () => {
      if (unresolved.current) {
        void unresolved.current().catch(() => setSaving(false))
      } else if (pending) {
        void confirm()
      } else if (lastIntent.current) {
        void requestChange(lastIntent.current)
      } else {
        void reload().then(() => setError(null))
      }
    },
    toggleKeep: (row: WorkspaceCleanupPreviewRow) =>
      setPending((value) => toggleCleanupKeep(value, row))
  }
}
