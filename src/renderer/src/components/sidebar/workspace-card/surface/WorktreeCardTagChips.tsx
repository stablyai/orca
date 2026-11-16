import React from 'react'
import { Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'

/** The workspace's tags as quiet chips under the title; wraps rather than truncating the set. */
export function WorktreeCardTagChips({ tags }: { tags: readonly string[] }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="flex min-w-0 flex-wrap gap-1"
      aria-label={t('auto.components.sidebar.WorktreeCardTagChips.label', 'Tags')}
    >
      {tags.map((tag) => (
        <Badge key={tag} variant="hostContext" className="max-w-[7rem]" title={tag}>
          <Tag />
          <span className="truncate">{tag}</span>
        </Badge>
      ))}
    </div>
  )
}
