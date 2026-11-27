import type React from 'react'
import { MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function ResumeInNewChatButton({
  primary,
  onResume
}: {
  primary: boolean
  onResume: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'secondary'}
      size="xs"
      draggable={false}
      onClick={(event) => {
        event.stopPropagation()
        onResume()
      }}
      className="h-7 shrink-0 px-2.5 text-[11px]"
    >
      <MessagesSquare className="size-3.5" />
      {t(
        'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
        'Resume in New Chat'
      )}
    </Button>
  )
}
