import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useOrgRoster } from '../../billing/team/use-org-roster'

/** The name the control plane sent, else the team roster's (the directory Home uses), else null. */
function useMemberName(name: string | null | undefined, id: string): string | null {
  const orgId = useAppStore((s) => s.orcaProfileAuthStatus?.cloud?.activeOrgId ?? null)
  const known = name?.trim() || null
  // Only read the shared roster when the server could not name this person.
  const roster = useOrgRoster(known ? null : orgId)
  if (known) {
    return known
  }
  if (roster.result?.status === 'ok') {
    const member = roster.result.roster.members.find((m) => m.userId === id)
    return member?.displayName?.trim() || member?.email || null
  }
  return null
}

/**
 * A teammate as a display name only, never a raw id inline; "Former member" when nobody can
 * name them. `idInTooltip` (audit log only) keeps the id one hover away for admins investigating.
 */
export function PersonName({
  name,
  id,
  idInTooltip = false
}: {
  name: string | null | undefined
  id: string
  idInTooltip?: boolean
}): React.JSX.Element {
  const display =
    useMemberName(name, id) ??
    translate('auto.components.settings.cloudApi.formerMember', 'Former member')
  return (
    <span className="text-foreground" title={idInTooltip ? id : undefined}>
      {display}
    </span>
  )
}

/**
 * A translated sentence with the person rendered in place of `<person></person>`, so word order
 * stays in the translation (no concatenation). `sentence` is the already-translated default.
 */
export function PersonSentence({
  sentence,
  name,
  id,
  idInTooltip
}: {
  sentence: string
  name: string | null | undefined
  id: string
  idInTooltip?: boolean
}): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={sentence}
      components={{ person: <PersonName name={name} id={id} idInTooltip={idInTooltip} /> }}
    />
  )
}
