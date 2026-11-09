import { ORCA_ORG_NAME_MAX_LENGTH } from '../../../../../shared/orca-org-management'
import { useId, useState } from 'react'
import { ArrowRight, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudOrgSummary } from '../../../../../shared/orca-profiles'
import { TeamMark } from './TeamAvatar'
import { normalizeOrgRole, roleLabel } from './team-roles'

export type TeamCreateViewProps = {
  /** Teams the user already belongs to (switch instead of creating). */
  organizations: OrcaCloudOrgSummary[]
  creating: boolean
  error: string | null
  /** This account service can't create teams yet: show a notice, not a field error. */
  unavailable: boolean
  switchingOrgId: string | null
  onCreate: (name: string) => void
  onSwitch: (orgId: string) => void
}

/** Personal account: create a team (you become its owner) or switch to one you're in. */
export function TeamCreateView(props: TeamCreateViewProps): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <div className="space-y-6">
      <section
        aria-labelledby={`${id}-title`}
        className="rounded-xl border border-border bg-card p-5 shadow-xs"
      >
        <div className="flex items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
            <Users className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {t('auto.components.billing.team.createTitle', 'Create a team')}
            </h3>
            <p className="text-sm text-muted-foreground text-pretty">
              {t(
                'auto.components.billing.team.createBody',
                'You’re on a personal account. A team shares one Orca Cloud plan: invite people, manage seats and billing in one place. You’ll be its owner.'
              )}
            </p>
          </div>
        </div>
        <form
          className="mt-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed && !props.creating && !props.unavailable) {
              props.onCreate(trimmed)
            }
          }}
        >
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            {t('auto.components.billing.team.teamName', 'Team name')}
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={ORCA_ORG_NAME_MAX_LENGTH}
              placeholder={t(
                'auto.components.billing.team.teamNamePlaceholder',
                'Acme Engineering'
              )}
              aria-invalid={props.error ? true : undefined}
              aria-describedby={props.error ? `${id}-error` : undefined}
              onChange={(event) => setName(event.target.value)}
              readOnly={props.creating}
              aria-disabled={props.creating || undefined}
              disabled={props.unavailable}
            />
            <Button
              type="submit"
              disabled={!props.creating && (!trimmed || props.unavailable)}
              aria-disabled={props.creating || undefined}
            >
              {props.creating ? <LoadingSpinner className="size-3.5" /> : null}
              {t('auto.components.billing.team.createCta', 'Create team')}
            </Button>
          </div>
          {props.unavailable ? (
            <p
              role="status"
              className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
            >
              {t(
                'auto.components.billing.team.createUnavailable',
                'Team creation isn’t available yet. Ask a teammate to invite you.'
              )}
            </p>
          ) : null}
          {props.error ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {props.error}
            </p>
          ) : null}
        </form>
      </section>

      {props.organizations.length > 0 ? (
        <section aria-labelledby={`${id}-switch`} className="space-y-2">
          <h3 id={`${id}-switch`} className="text-sm font-medium">
            {t('auto.components.billing.team.yourTeams', 'Or open a team you’re in')}
          </h3>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
            {props.organizations.map((org) => (
              <li key={org.orgId} className="flex items-center gap-3 bg-card px-3 py-2.5">
                <TeamMark name={org.name} className="size-8 text-xs" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{org.name}</p>
                  {org.role ? (
                    <p className="text-xs text-muted-foreground">
                      {roleLabel(normalizeOrgRole(org.role), t)}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={props.switchingOrgId !== null || undefined}
                  onClick={() => {
                    if (props.switchingOrgId === null) {
                      props.onSwitch(org.orgId)
                    }
                  }}
                >
                  {props.switchingOrgId === org.orgId ? (
                    <LoadingSpinner className="size-3.5" />
                  ) : null}
                  {t('auto.components.billing.team.switch', 'Switch')}
                  <ArrowRight />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
