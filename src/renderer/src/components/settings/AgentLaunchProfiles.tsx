// Profiles are host-owned launchers; Accounts continues to own enrollment and credentials.
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentLaunchProfile, ProfileAgent } from '../../../../shared/agent-launch-profile'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { AgentProfileForm } from './AgentProfileForm'
import { profileAccounts } from './agent-profile-accounts'

type Props = { agent: ProfileAgent; settings: GlobalSettings }
function ProfileEditor(props: Props & { profile?: AgentLaunchProfile }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!props.profile && (props.settings.agentLaunchProfiles?.length ?? 0) >= 32}
        >
          {props.profile
            ? translate('agentProfiles.edit', 'Edit')
            : translate('agentProfiles.add', 'Add profile')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" wheelScroll className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="max-h-[var(--radix-popover-content-available-height)] overflow-y-auto scrollbar-sleek p-4">
          {open && (
            <AgentProfileForm
              {...props}
              onClose={() => {
                setBusy(false)
                setOpen(false)
              }}
              onBusy={setBusy}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function AgentLaunchProfiles(props: Props) {
  const profiles = (props.settings.agentLaunchProfiles ?? []).filter(
    (profile) => profile.agent === props.agent && profile.hostId === 'local'
  )
  const accounts = profileAccounts(props.settings, props.agent)
  const removalPending = useRef(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const unlink = async (profile: AgentLaunchProfile) => {
    if (removalPending.current) {
      return
    }
    removalPending.current = true
    setRemoving(profile.id)
    setFailure(null)
    try {
      await window.api.agentProfiles.unlink(profile.id)
      toast.message(
        translate(
          'agentProfiles.unlinked',
          'Profile unlinked. Existing sessions, accounts and folders are preserved.'
        )
      )
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : translate('agentProfiles.unlinkError', 'Could not unlink this profile.')
      )
    } finally {
      removalPending.current = false
      setRemoving(null)
    }
  }
  return (
    <section
      className="mt-3 space-y-3"
      aria-label={translate('agentProfiles.section', 'Agent profiles')}
    >
      <div className="flex items-center gap-2">
        <ProfileEditor {...props} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            useAppStore.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
          }
        >
          {translate('agentProfiles.manageAccounts', 'Manage accounts')}
        </Button>
      </div>
      {profiles.length > 0 && (
        <ul className="space-y-2">
          {profiles.map((profile) => {
            const binding = profile.binding
            return (
              <li key={profile.id} className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{profile.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {binding.kind === 'external'
                      ? `${translate('agentProfiles.unverified', 'Unverified configuration')} · ${binding.home}`
                      : (accounts.find((account) => account.id === binding.accountId)?.email ??
                        translate(
                          'agentProfiles.unavailable',
                          'Account unavailable — edit to reconnect'
                        ))}
                  </p>
                </div>
                <ProfileEditor {...props} profile={profile} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(removing)}
                  onClick={() => void unlink(profile)}
                >
                  {translate('agentProfiles.unlink', 'Unlink')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </section>
  )
}
