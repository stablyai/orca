import { monaco } from '@/lib/monaco-setup'

function languageForWorkspaceModel(filePath: string): 'typescript' | 'javascript' | 'json' {
  if (/\.json$/i.test(filePath)) {
    return 'json'
  }
  return /\.(?:[cm]?tsx?)$/i.test(filePath) ? 'typescript' : 'javascript'
}

export function syncModel(modelPath: string, content: string): void {
  const uri = monaco.Uri.file(modelPath)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    return
  }
  monaco.editor.createModel(content, languageForWorkspaceModel(modelPath), uri)
}
