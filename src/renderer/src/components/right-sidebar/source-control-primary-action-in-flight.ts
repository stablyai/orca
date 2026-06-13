import { translate } from '@/i18n/i18n'
import {
  PRIMARY_LABEL_BY_KIND,
  type PrimaryAction,
  type PrimaryActionInputs
} from './source-control-primary-action-types'

export function resolvePrimaryActionDuringRemoteOp(
  inputs: PrimaryActionInputs,
  resolveWithoutRemoteOp: (inputs: PrimaryActionInputs) => PrimaryAction
): PrimaryAction {
  const { inFlightRemoteOpKind, hasUnresolvedConflicts } = inputs
  const candidate = resolveWithoutRemoteOp({ ...inputs, isRemoteOperationActive: false })
  const inFlightIsPrimaryKind =
    inFlightRemoteOpKind === 'push' ||
    inFlightRemoteOpKind === 'pull' ||
    inFlightRemoteOpKind === 'sync' ||
    inFlightRemoteOpKind === 'publish'

  if (inFlightRemoteOpKind === 'force_push') {
    return {
      kind: 'push',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.390abeab93',
        'Force Push'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.74fc171e99',
        'Force Push in progress…'
      ),
      disabled: true
    }
  }

  if (inFlightIsPrimaryKind && candidate.kind !== inFlightRemoteOpKind) {
    const label = PRIMARY_LABEL_BY_KIND[inFlightRemoteOpKind]
    return {
      kind: inFlightRemoteOpKind,
      label,
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.484f45c439',
        '{{value0}} in progress…',
        { value0: label }
      ),
      disabled: true
    }
  }

  // Why: when the candidate label is "Commit", the generic "remote
  // operation in progress…" tooltip mismatches the visible label. Point
  // the user at the fact that the commit will wait, keeping the label and
  // the explanation consistent. Conflicts take precedence over the remote
  // tooltip because resolving them is the only action the user can start
  // while the remote op runs.
  const title = hasUnresolvedConflicts
    ? 'Resolve conflicts before committing'
    : candidate.kind === 'commit'
      ? 'Remote operation in progress — try again once it finishes'
      : 'Remote operation in progress…'
  return {
    ...candidate,
    title,
    disabled: true
  }
}
