import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { CustomProviderAccountCard } from './CustomProviderAccountCard'
import { CustomProviderAccountForm } from './CustomProviderAccountForm'
import {
  buildCustomProviderAccount,
  EMPTY_CUSTOM_PROVIDER_DRAFT,
  getEditingDraftForAccount,
  validateCustomProviderDraft,
  type CustomProviderDraft
} from './custom-provider-draft'
import type {
  CustomProviderAccount,
  CustomProviderUsageResult
} from '../../../../shared/custom-provider-types'
import { translate } from '@/i18n/i18n'

function makeAccountId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Why: a stable module-level reference so the selector below never returns a
// fresh array on every store write when settings hasn't hydrated yet.
const EMPTY_CUSTOM_PROVIDER_ACCOUNTS: CustomProviderAccount[] = []

export function CustomProviderAccountsSection(): React.JSX.Element {
  const accounts = useAppStore(
    (s) => s.settings?.customProviderAccounts ?? EMPTY_CUSTOM_PROVIDER_ACCOUNTS
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const usageByAccountId = useAppStore((s) => s.rateLimits.customProviderUsage)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const mountedRef = useMountedRef()

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CustomProviderDraft>(EMPTY_CUSTOM_PROVIDER_DRAFT)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CustomProviderUsageResult | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Why: bumped on every form edit so a testDraft response that resolves
  // AFTER a later edit (the response races the edit, not just the request)
  // is discarded instead of re-enabling Save for a draft it never tested.
  const testGenerationRef = useRef(0)

  const openAddForm = (): void => {
    setEditingId(null)
    setForm(EMPTY_CUSTOM_PROVIDER_DRAFT)
    setTestResult(null)
    testGenerationRef.current += 1
    setShowForm(true)
  }

  const handleEdit = (account: CustomProviderAccount): void => {
    setEditingId(account.id)
    setForm(getEditingDraftForAccount(account))
    // Why: an existing entry was validated when first saved — re-testing is
    // only required if the user actually changes something below.
    setTestResult({
      accountId: account.id,
      usedPercent: 0,
      resetsAt: null,
      updatedAt: 0,
      error: null,
      status: 'ok'
    })
    testGenerationRef.current += 1
    setShowForm(true)
  }

  const handleFormChange = (updater: (prev: CustomProviderDraft) => CustomProviderDraft): void => {
    setForm((prev) => updater(prev))
    // Why: any edit invalidates a prior successful test — Save must not trust
    // a test that ran against different field values.
    setTestResult(null)
    testGenerationRef.current += 1
  }

  const handleTest = async (): Promise<void> => {
    const generation = testGenerationRef.current
    const editing = editingId ? accounts.find((a) => a.id === editingId) : null
    const draftAccount = {
      id: editing?.id ?? 'draft',
      createdAt: editing?.createdAt ?? Date.now(),
      ...buildCustomProviderAccount(form, editing ?? null)
    }
    setTesting(true)
    try {
      const result = await window.api.customProviderAccounts.testDraft(
        draftAccount,
        form.token.trim()
      )
      if (mountedRef.current && generation === testGenerationRef.current) {
        setTestResult(result)
      }
    } catch (err) {
      if (mountedRef.current && generation === testGenerationRef.current) {
        setTestResult({
          accountId: draftAccount.id,
          usedPercent: null,
          resetsAt: null,
          updatedAt: Date.now(),
          error: err instanceof Error ? err.message : 'Test failed',
          status: 'error'
        })
      }
    } finally {
      if (mountedRef.current) {
        setTesting(false)
      }
    }
  }

  const handleSave = async (): Promise<void> => {
    const validation = validateCustomProviderDraft(form, accounts, editingId)
    if (!validation.ok) {
      toast.error(validation.error)
      return
    }
    if (saving) {
      return
    }
    setSaving(true)
    try {
      const editing = editingId ? accounts.find((a) => a.id === editingId) : null
      const id = editing?.id ?? makeAccountId()
      const account: CustomProviderAccount = {
        id,
        createdAt: editing?.createdAt ?? Date.now(),
        ...buildCustomProviderAccount(form, editing ?? null)
      }
      const nextAccounts = editing
        ? accounts.map((a) => (a.id === id ? account : a))
        : [...accounts, account]
      await updateSettings({ customProviderAccounts: nextAccounts })
      if (form.token.trim()) {
        await window.api.customProviderAccounts.saveToken(id, form.token.trim())
      } else {
        // Why: saveToken's IPC handler is what wakes the main-process poll
        // loop today — an env-var-only account (no Bearer token typed) would
        // otherwise sit at "Not fetched yet" until the next scheduled poll.
        void refreshRateLimits()
      }
      recordFeatureInteraction('usage-tracking')
      if (!mountedRef.current) {
        return
      }
      toast.success(
        editing
          ? translate(
              'auto.components.settings.CustomProviderAccountsSection.updated',
              'Provider updated'
            )
          : translate(
              'auto.components.settings.CustomProviderAccountsSection.added',
              'Provider added'
            )
      )
      setShowForm(false)
      setEditingId(null)
      setForm(EMPTY_CUSTOM_PROVIDER_DRAFT)
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.CustomProviderAccountsSection.saveFailed',
                'Failed to save provider'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  const handleToggleEnabled = async (
    account: CustomProviderAccount,
    enabled: boolean
  ): Promise<void> => {
    setBusyId(account.id)
    try {
      await updateSettings({
        customProviderAccounts: accounts.map((a) => (a.id === account.id ? { ...a, enabled } : a))
      })
      // Why: re-enabling would otherwise show stale/no usage until the next poll.
      void refreshRateLimits()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.CustomProviderAccountsSection.toggleFailed',
                'Failed to update provider'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
      }
    }
  }

  const handleRemove = async (account: CustomProviderAccount): Promise<void> => {
    setBusyId(account.id)
    try {
      await updateSettings({ customProviderAccounts: accounts.filter((a) => a.id !== account.id) })
      await window.api.customProviderAccounts.clearToken(account.id)
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.CustomProviderAccountsSection.removed',
            'Provider removed'
          )
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.CustomProviderAccountsSection.removeFailed',
                'Failed to remove provider'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
      }
    }
  }

  return (
    <section
      key="custom-providers"
      id="accounts-custom-providers"
      className="space-y-4 scroll-mt-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.CustomProviderAccountsSection.title',
              'Custom Providers'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CustomProviderAccountsSection.description',
              'Add an internal usage-tracking endpoint to show its usage in the status bar.'
            )}
          </p>
        </div>
        <Button variant="outline" size="xs" className="gap-1.5" onClick={openAddForm}>
          <Plus className="size-3" />
          {translate('auto.components.settings.CustomProviderAccountsSection.add', 'Add Provider')}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.CustomProviderAccountsSection.empty',
            'No custom providers configured.'
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <CustomProviderAccountCard
              key={account.id}
              account={account}
              usage={usageByAccountId[account.id]}
              busy={busyId === account.id}
              onToggleEnabled={(a, enabled) => void handleToggleEnabled(a, enabled)}
              onEdit={handleEdit}
              onRemove={(a) => void handleRemove(a)}
            />
          ))}
        </div>
      )}

      <CustomProviderAccountForm
        open={showForm}
        isEditing={editingId != null}
        form={form}
        saving={saving}
        testing={testing}
        testResult={testResult}
        onFormChange={handleFormChange}
        onTest={() => void handleTest()}
        onSave={() => void handleSave()}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setShowForm(false)
            setEditingId(null)
            setForm(EMPTY_CUSTOM_PROVIDER_DRAFT)
          }
        }}
      />
    </section>
  )
}
