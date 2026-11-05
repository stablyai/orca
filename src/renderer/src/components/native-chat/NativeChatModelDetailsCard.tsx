import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { NativeChatModelDetails } from '../../../../shared/native-chat/input/native-chat-model-details'
import { nativeChatModelDetailRows } from './native-chat-model-detail-rows'

export function NativeChatModelDetailsCard(props: {
  label: string
  details: NativeChatModelDetails
}): React.JSX.Element {
  const rows = nativeChatModelDetailRows(props.details)
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{props.label}</span>
        {props.details.free ? (
          <Badge variant="secondary" className="ml-auto">
            {translate('components.native-chat.modelDetails.free', 'Free')}
          </Badge>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {rows.map((row) => (
            <div key={row.id} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
