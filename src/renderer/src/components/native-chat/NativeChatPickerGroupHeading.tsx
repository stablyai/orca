import { useTranslate, type Translate } from '@/i18n/use-translate'

const GROUP_HEADINGS = {
  commands: (t: Translate) => t('components.native-chat.composer.commands', 'Commands'),
  skills: (t: Translate) => t('components.native-chat.composer.skills', 'Skills'),
  agents: (t: Translate) => t('components.native-chat.composer.agents', 'Agents'),
  recent: (t: Translate) => t('components.native-chat.composer.recent', 'Recent'),
  bots: (t: Translate) => t('components.native-chat.composer.bots', 'Bots'),
  chats: (t: Translate) => t('components.native-chat.composer.hostChats', 'Chats'),
  terminals: (t: Translate) => t('components.native-chat.composer.hostTerminals', 'Terminals'),
  files: (t: Translate) => t('components.native-chat.composer.files', 'Files')
}

/** A group's heading in the `/` and `@` menus. */
export function PickerGroupHeading({
  kind
}: {
  kind: keyof typeof GROUP_HEADINGS
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {GROUP_HEADINGS[kind](t)}
    </div>
  )
}
