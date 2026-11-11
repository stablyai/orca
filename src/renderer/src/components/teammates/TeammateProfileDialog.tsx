// Teammate profile (Conductor 0.91 parity): who they are (roster), how much they used Orca Cloud
// each day (levels for teammates, amounts only for yourself), the workspaces of theirs you can
// already open, and a Poke button when both of you have Pokes on.
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { TeammateProfile } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { useOrgRoster } from '../billing/team/use-org-roster'
import { openCloudWorkspacesHome } from '../cloud-workspaces/cloud-workspaces-home-nav'
import { signInAgainMessage } from '@/lib/orca-cloud/orca-sign-in-again'
import { openCloudWorkspace } from '../cloud-workspaces/open-cloud-workspace'
import { pokeRefusalCopy } from './poke-copy'
import { localUtcOffsetMinutes } from './teammate-heatmap'
import { closeTeammateProfile, useOpenTeammateProfile } from './teammate-profile-store'
import { TeammateProfileView, type TeammatePokeState } from './TeammateProfileView'

// Machine error code for a failed IPC call (never shown); copy comes from the branches below.
const UNAVAILABLE = { ok: false as const, error: 'unavailable' as const }

function shortId(userId: string): string {
  const tail = userId.split(':').at(-1) ?? userId
  return tail.length > 12 ? `${tail.slice(0, 8)}…` : tail
}

function ProfileBody({ userId }: { userId: string }): React.JSX.Element {
  const t = useTranslate()
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const roster = useOrgRoster(cloud?.activeOrgId ?? null)
  const [profile, setProfile] = useState<TeammateProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [poke, setPoke] = useState<TeammatePokeState>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(() => {
    let cancelled = false
    setError(null)
    void window.api.cloudWorkspaces
      .teammateProfile(userId, localUtcOffsetMinutes())
      .catch(() => UNAVAILABLE)
      .then((result) => {
        if (cancelled) {
          return
        }
        setNow(Date.now())
        if (result.ok) {
          setProfile(result.value)
        } else {
          setError(
            result.error === 'unauthorized'
              ? signInAgainMessage(t)
              : t(
                  'auto.components.teammates.unreachable',
                  'Can’t reach Orca Cloud right now. Check your connection.'
                )
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [userId, t])
  useEffect(() => load(), [load])

  const member =
    roster.result?.status === 'ok'
      ? roster.result.roster.members.find((m) => m.userId === userId)
      : undefined
  const name = member?.displayName ?? member?.email ?? profile?.name ?? shortId(userId)

  const sendPoke = (): void => {
    setPoke({ kind: 'sending' })
    void window.api.cloudWorkspaces
      .poke(userId)
      .catch(() => UNAVAILABLE)
      .then((result) => {
        if (result.ok) {
          // The footer says "Poked {name}"; a toast too would say it twice.
          setPoke({ kind: 'sent', at: result.value.at })
        } else {
          setPoke({ kind: 'refused', message: pokeRefusalCopy(result, name, t) })
        }
      })
  }

  return (
    <TeammateProfileView
      userId={userId}
      name={name}
      email={member?.email ?? null}
      {...(member?.pictureUrl ? { pictureUrl: member.pictureUrl } : {})}
      role={member?.role ?? null}
      profile={profile}
      error={error}
      poke={poke}
      now={now}
      onRetry={load}
      onPoke={sendPoke}
      onOpenWorkspace={(workspace) => {
        closeTeammateProfile()
        void openCloudWorkspace(workspace).then((outcome) => {
          if (!outcome.ok) {
            toast.error(outcome.message)
          }
        })
      }}
      onShowAllWorkspaces={() => {
        closeTeammateProfile()
        openCloudWorkspacesHome({ scope: 'team', by: userId })
      }}
      onTurnOnPokes={() => {
        closeTeammateProfile()
        const state = useAppStore.getState()
        state.openSettingsTarget({
          pane: 'experimental',
          repoId: null,
          sectionId: 'experimental-pokes'
        })
        state.openSettingsPage()
      }}
    />
  )
}

export function TeammateProfileDialog(): React.JSX.Element {
  const t = useTranslate()
  const userId = useOpenTeammateProfile()
  return (
    <Dialog
      open={userId !== null}
      onOpenChange={(next) => {
        if (!next) {
          closeTeammateProfile()
        }
      }}
    >
      {userId ? (
        <DialogContent
          scrollable
          className="top-[10vh] max-h-[80vh] translate-y-0 sm:max-w-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            document.querySelector<HTMLElement>('[data-teammate-profile-heading]')?.focus()
          }}
        >
          <DialogTitle className="sr-only">
            {t('auto.components.teammates.title', 'Teammate profile')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              'auto.components.teammates.description',
              'Role, daily Orca Cloud usage and recent workspaces.'
            )}
          </DialogDescription>
          {/* Remount per person so one profile's state never shows on the next. */}
          <ProfileBody key={userId} userId={userId} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
