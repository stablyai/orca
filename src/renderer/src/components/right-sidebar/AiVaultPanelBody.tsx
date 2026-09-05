import { AiVaultPanelHeader, type AiVaultPanelHeaderProps } from './AiVaultPanelHeader'
import {
  AiVaultPanelSessionList,
  type AiVaultPanelSessionListProps
} from './AiVaultPanelSessionList'

export function AiVaultPanelBody({
  header,
  list
}: {
  header: AiVaultPanelHeaderProps
  list: AiVaultPanelSessionListProps
}): React.JSX.Element {
  return (
    <div className="@container/ai-vault flex h-full min-h-0 flex-col bg-sidebar">
      <AiVaultPanelHeader {...header} />
      <AiVaultPanelSessionList {...list} />
    </div>
  )
}
