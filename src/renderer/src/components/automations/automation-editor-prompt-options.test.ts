import { describe, expect, it } from 'vitest'
import { monacoFindOptions } from '@/components/editor/monaco-find-options'
import { buildAutomationPromptEditorOptions } from './automation-editor-prompt-options'

describe('buildAutomationPromptEditorOptions', () => {
  it('enables wrap and the shared find widget without code-editor chrome', () => {
    const options = buildAutomationPromptEditorOptions({
      ariaLabel: 'Prompt',
      fontFamily: 'Geist',
      fontSize: 14,
      placeholder: 'Run the weekly dependency audit'
    })

    expect(options.find).toEqual(monacoFindOptions)
    expect(options.wordWrap).toBe('on')
    expect(options.lineNumbers).toBe('off')
    expect(options.minimap).toEqual({ enabled: false })
    expect(options.ariaLabel).toBe('Prompt')
    expect(options.fontFamily).toBe('Geist')
    expect(options.fontSize).toBe(14)
    expect(options.placeholder).toBe('Run the weekly dependency audit')
  })
})
