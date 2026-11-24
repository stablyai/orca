import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Package } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptPill } from './NativeChatPromptPill'

function titleWords(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

/** `$work-pets:create-pet` reads "Create Pet (Work Pets)": the skill, then the plugin it is in. */
export function skillLabel(token: string): string {
  // Pi's `/skill:<name>`: the icon already says skill.
  const name = token.replace(/^[$/](skill:)?/, '')
  const split = name.indexOf(':')
  return split > 0
    ? `${titleWords(name.slice(split + 1))} (${titleWords(name.slice(0, split))})`
    : titleWords(name)
}

export function NativeChatSkillPill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const token = String(node.attrs.token)
  const label = skillLabel(token)
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={Package}
        label={label}
        spokenLabel={t('components.native-chat.composer.skillPillLabel', 'Skill: {{name}}', {
          name: label
        })}
        selected={selected}
        data-native-chat-skill={token}
      />
    </NodeViewWrapper>
  )
}
