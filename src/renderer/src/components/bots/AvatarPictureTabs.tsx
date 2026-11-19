// The picker's Choose and Generate tabs; without an image-capable agent, only the choices show.
import React, { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { AvatarGeneratePanel } from './AvatarGeneratePanel'
import { useAvatarGeneration } from './use-avatar-generation'

export type AvatarPictureTab = 'choose' | 'generate'

function dataUrlBlob(dataUrl: string): Blob {
  const [header, base64 = ''] = dataUrl.split(',', 2)
  const type = /^data:([^;]+);base64$/.exec(header)?.[1] ?? 'image/png'
  return new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], { type })
}

export function AvatarPictureTabs({
  tab,
  onTabChange,
  choose,
  backgroundColor,
  onImage
}: {
  tab: AvatarPictureTab
  onTabChange: (tab: AvatarPictureTab) => void
  /** The mascots, colors and upload line. */
  choose: React.ReactNode
  /** The chosen tile color; a generated picture is asked to use it as its background. */
  backgroundColor: string | null
  /** The used image, saved through the same crop as an upload. */
  onImage: (image: Blob) => void
}): React.JSX.Element {
  const t = useTranslate()
  const generation = useAvatarGeneration()
  const [description, setDescription] = useState('')
  // Generate shows only when an installed, image-capable agent can run here.
  if (generation.agent === null) {
    return <>{choose}</>
  }
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value === 'generate' ? 'generate' : 'choose')}
    >
      <TabsList size="sm" className="w-full">
        <TabsTrigger value="choose">{t('bots.avatar.generate.chooseTab', 'Choose')}</TabsTrigger>
        <TabsTrigger value="generate">
          <Sparkles />
          {t('bots.avatar.generate.tab', 'Generate')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="choose">{choose}</TabsContent>
      <TabsContent value="generate">
        <AvatarGeneratePanel
          agents={generation.agents}
          agent={generation.agent}
          onAgentChange={generation.selectAgent}
          state={generation.state}
          description={description}
          onDescriptionChange={(next) => {
            setDescription(next)
            if (generation.state.kind === 'error') {
              generation.reset()
            }
          }}
          onGenerate={() => generation.generate(description, backgroundColor ?? undefined)}
          onCancel={generation.cancel}
          onEdit={generation.reset}
          onPick={(image) => {
            onImage(dataUrlBlob(image))
            generation.reset()
          }}
        />
      </TabsContent>
    </Tabs>
  )
}
