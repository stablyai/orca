import { createLowlight } from 'lowlight'
import { MARKDOWN_CODE_LANGUAGES } from '@/lib/markdown/markdown-code-languages'
import { createCachedLowlight } from './rich-markdown-lowlight-cache'

export const richMarkdownLowlight = createCachedLowlight(createLowlight(MARKDOWN_CODE_LANGUAGES))
