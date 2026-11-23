import type { PerforceOutsideFile } from '../../../../../shared/perforce/perforce-types'
import { perforceActionBadge } from './perforce-file-row'
import { translate } from '@/i18n/i18n'

/** A file opened outside this folder: listed so a submit never sends files the panel did not show. */
export function PerforceOutsideFileRow({ file }: { file: PerforceOutsideFile }) {
  const source = file.clientPath ?? file.depotPath
  const slash = source.lastIndexOf('/')
  const name = source.slice(slash + 1)
  const dir = slash === -1 ? '' : source.slice(0, slash)
  const { label, color } = perforceActionBadge(file.action, 'opened')
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-2 py-0.5 text-[13px] text-muted-foreground"
      title={translate('perforce.ui.openedOutsideFolder', 'Opened outside this folder: {{path}}', {
        path: file.depotPath
      })}
    >
      <span className="w-3 shrink-0 text-center text-[11px] font-semibold" style={{ color }}>
        {label}
      </span>
      <span className="truncate">{name}</span>
      {dir ? <span className="truncate text-xs">{dir}</span> : null}
    </div>
  )
}
