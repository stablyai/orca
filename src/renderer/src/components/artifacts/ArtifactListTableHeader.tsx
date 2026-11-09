import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { ARTIFACTS_TABLE_GRID_CLASS } from './artifacts-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-table-layout'

export function ArtifactListTableHeader(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={cn(ARTIFACTS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
      <span>{t('auto.components.artifacts.ArtifactListTableHeader.name', 'Name')}</span>
      <span>{t('auto.components.artifacts.ArtifactListTableHeader.type', 'Type')}</span>
      <span>{t('auto.components.artifacts.ArtifactListTableHeader.size', 'Size')}</span>
      <span>{t('auto.components.artifacts.ArtifactListTableHeader.updated', 'Updated')}</span>
      <span>{t('auto.components.artifacts.ArtifactListTableHeader.expires', 'Expires')}</span>
      <span className="sr-only">
        {t('auto.components.artifacts.ArtifactListTableHeader.actions', 'Actions')}
      </span>
    </div>
  )
}
