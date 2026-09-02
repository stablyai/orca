import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ARTIFACTS_TABLE_GRID_CLASS } from './artifacts-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-table-layout'

export function ArtifactListTableHeader(): React.JSX.Element {
  return (
    <div className={cn(ARTIFACTS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.name', 'Name')}</span>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.type', 'Type')}</span>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.size', 'Size')}</span>
      <span>
        {translate('auto.components.artifacts.ArtifactListTableHeader.updated', 'Updated')}
      </span>
      <span>
        {translate('auto.components.artifacts.ArtifactListTableHeader.expires', 'Expires')}
      </span>
      <span className="sr-only">
        {translate('auto.components.artifacts.ArtifactListTableHeader.actions', 'Actions')}
      </span>
    </div>
  )
}
