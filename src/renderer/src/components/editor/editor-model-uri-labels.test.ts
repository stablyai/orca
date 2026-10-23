// @vitest-environment happy-dom
// Why: peek, references and snippet variables label a model by Monaco's default label service,
// which shows a non-file URI's path, so an owned model must keep the host's real path there.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { ModelBasedVariableResolver } from 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetVariables.js'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { ILabelService } from 'monaco-editor/esm/vs/platform/label/common/label.js'
import { describe, expect, it } from 'vitest'
import { toEditorModelUri } from './editor-model-uri'

const OWNER = '["hub-a","ssh:target"]'

function snippetPathVariables(filePath: string, owner: string): (string | undefined)[] {
  const model = monaco.editor.createModel(
    '',
    'plaintext',
    monaco.Uri.parse(toEditorModelUri(filePath, owner))
  )
  try {
    const resolver = new ModelBasedVariableResolver(StandaloneServices.get(ILabelService), model)
    return ['TM_FILEPATH', 'TM_DIRECTORY', 'TM_DIRECTORY_BASE', 'TM_FILENAME'].map((name) =>
      resolver.resolve({ name })
    )
  } finally {
    model.dispose()
  }
}

describe('owned model labels', () => {
  it('fill snippet path variables with the host path', () => {
    expect(snippetPathVariables('/repo/src/a.ts', OWNER)).toEqual([
      '/repo/src/a.ts',
      '/repo/src',
      'src',
      'a.ts'
    ])
  })

  it('show a remote Windows path with a leading slash', () => {
    expect(snippetPathVariables('C:/repo/a.ts', OWNER).slice(0, 2)).toEqual([
      '/c:/repo/a.ts',
      '/c:/repo'
    ])
  })
})
