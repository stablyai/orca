import type { ReactNode } from 'react'
import { AudioLines, History } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'

export function NativeChatVoiceLayout({
  children,
  history
}: {
  children: ReactNode
  history: ReactNode
}): React.JSX.Element {
  return (
    <Tabs defaultValue="voice" className="min-h-0 flex-1">
      <TabsList
        className="mx-3 my-2 w-auto shrink-0"
        aria-label={translate('stsVoice.open', 'Voice conversation')}
      >
        <TabsTrigger value="voice">
          <AudioLines className="size-4" aria-hidden />
          {translate('stsHistory.voice', 'Voice')}
        </TabsTrigger>
        <TabsTrigger value="history">
          <History className="size-4" aria-hidden />
          {translate('stsHistory.title', 'Conversation history')}
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="voice"
        forceMount
        className="flex min-h-0 flex-col data-[state=inactive]:hidden"
      >
        {children}
      </TabsContent>
      <TabsContent value="history" className="flex min-h-0 flex-col data-[state=inactive]:hidden">
        {history}
      </TabsContent>
    </Tabs>
  )
}
