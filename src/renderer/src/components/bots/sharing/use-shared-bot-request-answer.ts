import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'

/** Accept or Decline of one request, as its row and its page both answer it. */
export function useSharedBotRequestAnswer(shareId: string): {
  answering: boolean
  answer: (accept: boolean) => Promise<void>
} {
  const t = useTranslate()
  const [answering, setAnswering] = useState(false)
  const answer = async (accept: boolean): Promise<void> => {
    setAnswering(true)
    const args = { shareId }
    const done = await (
      accept ? window.api.sharedBotHosts.accept(args) : window.api.sharedBotHosts.decline(args)
    ).catch(() => false)
    if (!done) {
      setAnswering(false)
      toast.error(t('bots.share.requestFailed', 'Couldn’t answer the request. Try again.'))
    }
  }
  return { answering, answer }
}
