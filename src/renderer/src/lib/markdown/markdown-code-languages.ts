import { common } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'

// Why: the rich editor and the preview share one set so a registered language highlights the same in both.
// lowlight's common set omits PowerShell, which the rich editor's language picker offers.
export const MARKDOWN_CODE_LANGUAGES = { ...common, powershell }
