import { bundledLanguagesInfo } from 'shiki/langs'
import {
  getCodeBlockLanguageLabel,
  isKnownCodeBlockLanguage
} from '@/components/editor/rich-markdown-code-block-languages'

/** Prefer picker labels, then highlighting names/aliases, then the original fence tag. */
export function getCodeFenceLanguageLabel(tag: string): string {
  const key = tag.trim().toLowerCase()
  if (isKnownCodeBlockLanguage(key)) {
    return getCodeBlockLanguageLabel(key)
  }
  const info = bundledLanguagesInfo.find(
    (language) => language.id === key || language.aliases?.includes(key)
  )
  if (!info) {
    return tag
  }
  return isKnownCodeBlockLanguage(info.id) ? getCodeBlockLanguageLabel(info.id) : info.name
}
