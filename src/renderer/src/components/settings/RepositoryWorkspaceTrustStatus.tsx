import type React from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceTrustEntry } from '../../../../shared/workspace-trust-types'
import { resolveWorkspaceTrustMatch } from '../../../../shared/workspace-trust-resolution'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

type TrustCardState =
  | { kind: 'trusted-direct'; entryId: string }
  | { kind: 'trusted-inherited'; entryId: string; ancestorPath: string }
  | { kind: 'declined' }
  | { kind: 'undecided' }
  | { kind: 'not-applicable' }

const TRUST_STATE_STYLES: Record<TrustCardState['kind'], { card: string; titleClassName: string }> =
  {
    'trusted-direct': {
      card: 'border-emerald-500/20 bg-emerald-500/5',
      titleClassName: 'text-emerald-700 dark:text-emerald-300'
    },
    'trusted-inherited': {
      card: 'border-emerald-500/20 bg-emerald-500/5',
      titleClassName: 'text-emerald-700 dark:text-emerald-300'
    },
    declined: {
      card: 'border-amber-500/20 bg-amber-500/5',
      titleClassName: 'text-amber-700 dark:text-amber-300'
    },
    undecided: {
      card: 'border-amber-500/20 bg-amber-500/5',
      titleClassName: 'text-amber-700 dark:text-amber-300'
    },
    'not-applicable': { card: 'border-border/50 bg-muted/20', titleClassName: 'text-foreground' }
  }

/**
 * The recorded decision, never effective access: main's gate re-verifies canonically
 * (`isWorkspaceTrusted`), while this card reads the textual match the user actually chose
 * (`getWorkspaceTrustDecision`'s half of the split). Copy must therefore describe the decision.
 */
function resolveTrustCardState(
  repo: Repo,
  entries: readonly WorkspaceTrustEntry[]
): TrustCardState {
  if (repo.connectionId != null) {
    return { kind: 'not-applicable' }
  }
  const match = resolveWorkspaceTrustMatch(repo.path, entries)
  if (!match) {
    return { kind: 'undecided' }
  }
  if (!match.entry.trusted) {
    return { kind: 'declined' }
  }
  return match.matchKind === 'exact'
    ? { kind: 'trusted-direct', entryId: match.entry.id }
    : { kind: 'trusted-inherited', entryId: match.entry.id, ancestorPath: match.entry.path }
}

function getTrustStateCopy(
  state: TrustCardState,
  path: string
): { heading: string; description: string } {
  switch (state.kind) {
    case 'trusted-direct':
      return {
        heading: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.trustedHeading',
          'Trusted'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.trustedDescription',
          'You trusted {{path}}. The decision is recorded for that exact location and covers everything nested beneath it.',
          { path }
        )
      }
    case 'trusted-inherited':
      return {
        heading: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.inheritedHeading',
          'Trust inherited from {{ancestorPath}}',
          { ancestorPath: state.ancestorPath }
        ),
        description: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.inheritedDescription',
          'No decision is recorded for {{path}} itself, so it inherits the one recorded for {{ancestorPath}}.',
          { path, ancestorPath: state.ancestorPath }
        )
      }
    case 'declined':
      return {
        heading: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.untrustedHeading',
          'Not trusted'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.declinedDescription',
          'You declined trust for {{path}}. Orca keeps that decision until you change it here.',
          { path }
        )
      }
    case 'not-applicable':
      return {
        heading: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.notApplicableHeading',
          'Not applicable'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.notApplicableDescription',
          '{{path}} is reached over a remote connection. Workspace trust records decisions about locations on this machine only.',
          { path }
        )
      }
    case 'undecided':
      return {
        heading: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.untrustedHeading',
          'Not trusted'
        ),
        description: translate(
          'auto.components.settings.RepositoryWorkspaceTrustStatus.undecidedDescription',
          'No trust decision is recorded for {{path}}. Orca treats a location with no recorded decision as not trusted.',
          { path }
        )
      }
  }
}

export function RepositoryWorkspaceTrustStatus({ repo }: { repo: Repo }): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const state = resolveTrustCardState(repo, settings?.workspaceTrustEntries ?? [])
  const copy = getTrustStateCopy(state, repo.path)
  const styles = TRUST_STATE_STYLES[state.kind]

  const decideForThisProject = (decision: 'trust' | 'decline'): void => {
    void window.api.workspaceTrust.decide({
      target: { kind: 'repo', repoId: repo.id },
      scope: 'workspace',
      decision
    })
  }

  const revokeEntry = (entryId: string): void => {
    void window.api.workspaceTrust.revoke({ entryId })
  }

  return (
    <div className={`space-y-3 rounded-xl border p-3 ${styles.card}`}>
      <div className="space-y-1">
        <p className={`text-sm font-medium ${styles.titleClassName}`}>{copy.heading}</p>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
        {state.kind === 'not-applicable' ? null : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryWorkspaceTrustStatus.effect',
              'This decision governs whether Orca reads package details from your local npm client instead of the public registry.'
            )}
          </p>
        )}
      </div>
      {state.kind === 'declined' || state.kind === 'undecided' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => decideForThisProject('trust')}
        >
          {translate(
            'auto.components.settings.RepositoryWorkspaceTrustStatus.trustProject',
            'Trust this project'
          )}
        </Button>
      ) : null}
      {state.kind === 'trusted-direct' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => revokeEntry(state.entryId)}
        >
          {translate(
            'auto.components.settings.RepositoryWorkspaceTrustStatus.revoke',
            'Revoke trust'
          )}
        </Button>
      ) : null}
      {/* Revoking an inherited grant is ambiguous: decline here only, or drop the ancestor and every sibling with it. */}
      {state.kind === 'trusted-inherited' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => decideForThisProject('decline')}
          >
            {translate(
              'auto.components.settings.RepositoryWorkspaceTrustStatus.declineProject',
              "Don't trust this project"
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => revokeEntry(state.entryId)}
          >
            {translate(
              'auto.components.settings.RepositoryWorkspaceTrustStatus.revokeAncestor',
              'Revoke trust for {{ancestorPath}}',
              { ancestorPath: state.ancestorPath }
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
