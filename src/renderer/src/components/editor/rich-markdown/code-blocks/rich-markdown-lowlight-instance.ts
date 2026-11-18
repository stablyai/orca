import { createLowlight, common } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'
import { createCachedLowlight } from './rich-markdown-lowlight-cache'

// The picker offers PowerShell, which lowlight's common set omits.
export const richMarkdownLowlight = createCachedLowlight(createLowlight({ ...common, powershell }))
