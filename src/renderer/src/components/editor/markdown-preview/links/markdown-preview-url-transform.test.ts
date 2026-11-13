import { describe, expect, it } from 'vitest'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'

describe('markdownPreviewUrlTransform', () => {
  it('preserves vscode and vscode-insiders editor deep links', () => {
    expect(markdownPreviewUrlTransform('vscode://file/D:/src/project/Example.cs:120', 'href')).toBe(
      'vscode://file/D:/src/project/Example.cs:120'
    )
    expect(
      markdownPreviewUrlTransform('vscode-insiders://file/D:/src/project/Example.cs:120', 'href')
    ).toBe('vscode-insiders://file/D:/src/project/Example.cs:120')
    expect(markdownPreviewUrlTransform('vscode://publisher.extension/do', 'href')).toBe('')
    expect(markdownPreviewUrlTransform('vscode://file/tmp/example.png', 'src')).toBe('')
  })
})
