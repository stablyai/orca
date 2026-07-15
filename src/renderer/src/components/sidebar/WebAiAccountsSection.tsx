import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { BrowserSessionProfile, WebAiAccount } from '../../../../shared/types'
import {
  getWebAiAccountWorkspaceId,
  normalizeWebAiAccounts,
  webAiAccountMatchesWorkspace
} from '../../../../shared/web-ai-accounts'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { WebAiAccountDialog } from './WebAiAccountDialog'
import { buildWebAiAccountFromDraft, type WebAiAccountDraft } from './web-ai-account-draft'
import WebAiAccountRow from './WebAiAccountRow'

const WebAiAccountsSection = React.memo(function WebAiAccountsSection() {
  useTranslation()
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const launchWebAiAccount = useAppStore((state) => state.launchWebAiAccount)
  const deleteWebAiAccount = useAppStore((state) => state.deleteWebAiAccount)
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const activeBrowserTabId = useAppStore((state) => state.activeBrowserTabId)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeTabType = useAppStore((state) => state.activeTabType)
  const activeView = useAppStore((state) => state.activeView)
  const webAiAccountsCollapsed = useAppStore((state) => state.webAiAccountsCollapsed)
  const setWebAiAccountsCollapsed = useAppStore((state) => state.setWebAiAccountsCollapsed)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const switchRuntimeEnvironment = useAppStore((state) => state.switchRuntimeEnvironment)
  const accounts = useMemo(
    () => normalizeWebAiAccounts(settings?.webAiAccounts),
    [settings?.webAiAccounts]
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [localProfiles, setLocalProfiles] = useState<BrowserSessionProfile[]>([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const managedProfilesRef = useRef(false)

  const refreshLocalProfiles = useCallback(async (): Promise<BrowserSessionProfile[] | null> => {
    try {
      const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
      setLocalProfiles(profiles)
      setProfilesLoaded(true)
      return profiles
    } catch {
      setLocalProfiles([])
      setProfilesLoaded(false)
      return null
    }
  }, [])

  useEffect(() => {
    void refreshLocalProfiles()
  }, [refreshLocalProfiles])

  useEffect(() => {
    if (!managedProfilesRef.current || activeView === 'settings') {
      return
    }
    managedProfilesRef.current = false
    void refreshLocalProfiles()
  }, [activeView, refreshLocalProfiles])

  const selectableProfiles = useMemo(
    () => localProfiles.filter((profile) => profile.scope !== 'default'),
    [localProfiles]
  )
  const localProfileById = useMemo(
    () => new Map(localProfiles.map((profile) => [profile.id, profile] as const)),
    [localProfiles]
  )

  const launchAccount = useCallback(
    async (account: WebAiAccount, openNewTab = false): Promise<void> => {
      const result = await launchWebAiAccount(account, { openNewTab })
      if (result.profiles) {
        setLocalProfiles(result.profiles)
        setProfilesLoaded(true)
      } else {
        setLocalProfiles([])
        setProfilesLoaded(false)
      }
      if (result.ok) {
        return
      }
      if (result.reason === 'profile-check-failed') {
        toast.error(
          translate(
            'auto.components.sidebar.WebAiAccountsSection.profileCheckFailed',
            'Could not verify browser profiles. Try again.'
          )
        )
        return
      }
      if (result.reason === 'profile-missing') {
        toast.error(
          translate(
            'auto.components.sidebar.WebAiAccountsSection.profileMissing',
            'This browser profile no longer exists.'
          )
        )
        return
      }
      toast.error(
        translate(
          'auto.components.sidebar.WebAiAccountsSection.launchFailed',
          'Failed to open this Web AI account.'
        )
      )
    },
    [launchWebAiAccount]
  )

  const openAddDialog = useCallback((): void => {
    setDialogOpen(true)
    void refreshLocalProfiles()
  }, [refreshLocalProfiles])

  const addAccount = useCallback(
    async (draft: WebAiAccountDraft): Promise<void> => {
      setSubmitting(true)
      let createdProfileId: string | null = null
      const cleanupCreatedProfile = async (): Promise<void> => {
        if (!createdProfileId) {
          return
        }
        const profileId = createdProfileId
        createdProfileId = null
        try {
          const deleted = await window.api.browser.sessionDeleteProfile({ profileId })
          if (deleted) {
            setLocalProfiles((current) => current.filter((entry) => entry.id !== profileId))
          }
        } catch {
          // Why: settings failure remains the user-visible error. Cleanup is
          // best-effort and must never mask it or touch a selected profile.
        }
      }
      try {
        const currentProfiles = draft.profileId ? await refreshLocalProfiles() : localProfiles
        if (draft.profileId && !currentProfiles) {
          toast.error(
            translate(
              'auto.components.sidebar.WebAiAccountsSection.profileCheckFailed',
              'Could not verify browser profiles. Try again.'
            )
          )
          return
        }
        let profile = draft.profileId
          ? (currentProfiles?.find(
              (entry) => entry.id === draft.profileId && entry.scope !== 'default'
            ) ?? null)
          : null
        if (draft.profileId && !profile) {
          toast.error(
            translate(
              'auto.components.sidebar.WebAiAccountsSection.profileMissing',
              'This browser profile no longer exists.'
            )
          )
          return
        }
        if (!profile) {
          profile = (await window.api.browser.sessionCreateProfile({
            scope: 'isolated',
            label: draft.label
          })) as BrowserSessionProfile | null
          if (!profile) {
            toast.error(
              translate(
                'auto.components.sidebar.WebAiAccountsSection.createProfileFailed',
                'Failed to create browser profile.'
              )
            )
            return
          }
          createdProfileId = profile.id
          setLocalProfiles((current) => [...current, profile!])
          setProfilesLoaded(true)
          if (!useAppStore.getState().settings?.activeRuntimeEnvironmentId) {
            void useAppStore.getState().fetchBrowserSessionProfiles()
          }
        }

        const state = useAppStore.getState()
        const account = buildWebAiAccountFromDraft({
          draft,
          profile,
          id: createBrowserUuid(),
          createdAt: Date.now()
        })
        const currentAccounts = normalizeWebAiAccounts(state.settings?.webAiAccounts)
        await updateSettings({ webAiAccounts: [...currentAccounts, account] })
        const saved = normalizeWebAiAccounts(useAppStore.getState().settings?.webAiAccounts).some(
          (entry) => entry.id === account.id
        )
        if (!saved) {
          await cleanupCreatedProfile()
          throw new Error('Web AI account settings were not persisted')
        }
        // Why: after persistence succeeds, the profile belongs to the saved
        // account and must survive any later launch failure.
        createdProfileId = null
        setDialogOpen(false)
        await launchAccount(account)
      } catch {
        await cleanupCreatedProfile()
        toast.error(
          translate(
            'auto.components.sidebar.WebAiAccountsSection.addFailed',
            'Failed to add Web AI account.'
          )
        )
      } finally {
        setSubmitting(false)
      }
    },
    [launchAccount, localProfiles, refreshLocalProfiles, updateSettings]
  )

  const manageProfiles = useCallback(async (): Promise<void> => {
    const switched = await switchRuntimeEnvironment(null)
    if (!switched) {
      toast.error(
        translate(
          'auto.components.sidebar.WebAiAccountsSection.openProfilesFailed',
          'Could not open local browser profile settings.'
        )
      )
      return
    }
    managedProfilesRef.current = true
    openSettingsTarget({ pane: 'browser', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget, switchRuntimeEnvironment])

  const removeAccount = useCallback(
    async (account: WebAiAccount): Promise<void> => {
      const removed = await deleteWebAiAccount(account.id)
      if (!removed) {
        toast.error(
          translate(
            'auto.components.sidebar.WebAiAccountsSection.removeFailed',
            'Failed to remove Web AI account.'
          )
        )
        return
      }
      toast.success(
        translate(
          'auto.components.sidebar.WebAiAccountsSection.removed',
          'Removed {{value0}} from the sidebar. The browser profile was kept.',
          { value0: account.label }
        )
      )
    },
    [deleteWebAiAccount]
  )

  return (
    <>
      <Collapsible
        open={!webAiAccountsCollapsed}
        onOpenChange={(open) => setWebAiAccountsCollapsed(!open)}
        className="border-y border-worktree-sidebar-border/55 px-2 py-1"
      >
        <div className="flex h-7 items-center gap-1">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-semibold text-worktree-sidebar-foreground/60 transition-colors hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/80"
              aria-label={translate(
                'auto.components.sidebar.WebAiAccountsSection.toggle',
                'Toggle Web AI Accounts'
              )}
            >
              {webAiAccountsCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0" />
              )}
              <Bot className="size-3.5 shrink-0 text-worktree-sidebar-foreground/40" />
              <span className="min-w-0 flex-1 truncate">
                {translate('auto.components.sidebar.WebAiAccountsSection.title', 'Web AI Accounts')}
              </span>
              {accounts.length > 0 ? (
                <span className="text-[10px] font-medium tabular-nums text-worktree-sidebar-foreground/35">
                  {accounts.length}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-worktree-sidebar-foreground/45 hover:text-worktree-sidebar-foreground"
                aria-label={translate(
                  'auto.components.sidebar.WebAiAccountsSection.add',
                  'Add Web AI account'
                )}
                onClick={openAddDialog}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>
              {translate('auto.components.sidebar.WebAiAccountsSection.add', 'Add Web AI account')}
            </TooltipContent>
          </Tooltip>
        </div>

        <CollapsibleContent className="max-h-56 overflow-y-auto pb-1 pt-0.5 scrollbar-sleek">
          {accounts.length === 0 ? (
            <button
              type="button"
              onClick={openAddDialog}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-worktree-sidebar-foreground/45 transition-colors hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/70"
            >
              <Plus className="size-3.5" />
              <span className="truncate">
                {translate(
                  'auto.components.sidebar.WebAiAccountsSection.addFirst',
                  'Add an account'
                )}
              </span>
            </button>
          ) : (
            <div className="space-y-0.5">
              {accounts.map((account) => {
                const profile = localProfileById.get(account.profileId) ?? null
                const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
                const workspaces = (browserTabsByWorktree[accountWorkspaceId] ?? []).filter(
                  (entry) => webAiAccountMatchesWorkspace(account, entry)
                )
                const active =
                  activeView === 'terminal' &&
                  activeWorktreeId === accountWorkspaceId &&
                  activeTabType === 'browser' &&
                  workspaces.some((workspace) => workspace.id === activeBrowserTabId)
                return (
                  <WebAiAccountRow
                    key={account.id}
                    account={account}
                    profile={profile}
                    profilesLoaded={profilesLoaded}
                    tabCount={workspaces.length}
                    active={active}
                    onLaunch={(entry, openNewTab) => void launchAccount(entry, openNewTab)}
                    onManageProfiles={() => void manageProfiles()}
                    onRemove={(entry) => void removeAccount(entry)}
                  />
                )
              })}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <WebAiAccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profiles={selectableProfiles}
        submitting={submitting}
        onSubmit={(draft) => void addAccount(draft)}
      />
    </>
  )
})

export default WebAiAccountsSection
