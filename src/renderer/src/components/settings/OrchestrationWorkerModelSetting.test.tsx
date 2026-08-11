import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  getWorkerModelAgents,
  OrchestrationWorkerModelSetting,
  updateOrchestrationWorkerEffort,
  updateOrchestrationWorkerModel
} from './OrchestrationWorkerModelSetting'

describe('OrchestrationWorkerModelSetting', () => {
  it('shows model controls only for agents with launch-time model support', () => {
    const agents = getWorkerModelAgents()
    expect(agents.map((agent) => agent.id)).toEqual(['claude', 'codex', 'cursor'])
    expect(agents.find((agent) => agent.id === 'codex')?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.6-luna' })])
    )
    const enrichedAgents = getWorkerModelAgents({
      codex: [{ id: 'gpt-account-model', label: 'GPT Account Model' }]
    })
    expect(enrichedAgents.find((agent) => agent.id === 'codex')?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-5.6-luna' }),
        expect.objectContaining({ id: 'gpt-account-model' })
      ])
    )

    const markup = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent="codex"
        disabledAgents={[]}
        models={{ codex: 'gpt-5.6-luna' }}
        efforts={{ codex: 'max' }}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(markup).toContain('Worker defaults')
    expect(markup).not.toContain('Default Worker:')
    expect(markup).toContain('aria-label="Default worker provider"')
    expect(markup).toContain('aria-label="Codex model"')
    expect(markup).toContain('aria-label="Codex effort"')
    expect(markup).toContain('title="GPT-5.6 Luna"')
    expect(markup).toContain('Agent default')
    expect(markup).not.toContain('Use agent default')
    expect(markup).not.toContain('Aider model')
  })

  it('carries discovered effort levels and the Codex fallback into worker model options', () => {
    const agents = getWorkerModelAgents({
      codex: [
        {
          id: 'gpt-account-model',
          label: 'GPT Account Model',
          thinkingLevels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' }
          ],
          defaultThinkingLevel: 'high'
        },
        { id: 'gpt-unseeded-model', label: 'GPT Unseeded Model' }
      ]
    })
    const codex = agents.find((agent) => agent.id === 'codex')!
    const effortChoices = (modelId: string) => {
      const effort = codex.models
        .find((model) => model.id === modelId)
        ?.options.find((option) => option.id === 'effort')
      return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
    }

    expect(effortChoices('gpt-account-model')).toEqual(['low', 'high'])
    expect(effortChoices('gpt-unseeded-model')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps all three controls visible when no provider is selected', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent={null}
        disabledAgents={[]}
        models={{ codex: 'gpt-5.6-luna' }}
        efforts={{ codex: 'max' }}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(markup).not.toContain('Default Worker:')
    expect(markup).toContain('aria-label="Default worker provider"')
    expect(markup).toContain('aria-label="Worker model"')
    expect(markup).toContain('aria-label="Worker effort"')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Worker model"/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Worker effort"/)
    expect(markup).toMatch(
      /<button[^>]*aria-label="Worker model"[^>]*>.*?Pick provider.*?<\/button>/s
    )
    expect(markup).toMatch(
      /<button[^>]*aria-label="Worker effort"[^>]*>.*?Pick provider.*?<\/button>/s
    )
  })

  it('disables model and effort for a provider without launch-time model support', () => {
    // gemini has no modelApply.launchArgs, so its dependent controls stay unavailable.
    const markup = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent="gemini"
        disabledAgents={[]}
        models={{}}
        efforts={{}}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(markup).toContain('aria-label="Gemini model"')
    expect(markup).toContain('aria-label="Gemini effort"')
    expect(markup).toContain('Not available')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Gemini model"/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Gemini effort"/)
  })

  it('disables Effort until the selected model actually offers effort choices', () => {
    // Cursor's "auto" model has no options; gpt-5.3-codex does.
    const withoutEffort = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent="cursor"
        disabledAgents={[]}
        models={{ cursor: 'auto' }}
        efforts={{}}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(withoutEffort).toContain('aria-label="Cursor model"')
    expect(withoutEffort).toContain('aria-label="Cursor effort"')
    expect(withoutEffort).toContain('Not available')
    expect(withoutEffort).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Cursor effort"/)

    const withEffort = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent="cursor"
        disabledAgents={[]}
        models={{ cursor: 'gpt-5.3-codex' }}
        efforts={{}}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(withEffort).toContain('aria-label="Cursor effort"')
    expect(withEffort).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Cursor effort"/)
  })

  it('renders only the selected worker controls, never another model-capable agent', () => {
    // Preferences are stored for both codex and claude, but codex is the
    // selected default worker — claude's row must not render alongside it.
    const markup = renderToStaticMarkup(
      <OrchestrationWorkerModelSetting
        defaultAgent="codex"
        disabledAgents={[]}
        models={{ codex: 'gpt-5.6-luna', claude: 'opus' }}
        efforts={{ codex: 'max', claude: 'high' }}
        onDefaultAgentChange={() => {}}
        onChange={() => {}}
      />
    )
    expect(markup).toContain('aria-label="Codex model"')
    expect(markup).toContain('aria-label="Codex effort"')
    expect(markup).not.toContain('aria-label="Claude model"')
    expect(markup).not.toContain('aria-label="Claude effort"')
    expect(markup).not.toContain('aria-label="Cursor model"')
    expect(markup).not.toContain('aria-label="Cursor effort"')
  })

  it('updates one agent without replacing other launch preferences and removes defaults', () => {
    const updated = updateOrchestrationWorkerModel(
      { claude: 'opus' },
      { claude: 'high' },
      'codex',
      'gpt-5.6-luna'
    )
    expect(updated).toEqual({
      models: { claude: 'opus', codex: 'gpt-5.6-luna' },
      efforts: { claude: 'high' }
    })
    const withEffort = updateOrchestrationWorkerEffort(updated.efforts, 'codex', 'max')
    expect(withEffort).toEqual({ claude: 'high', codex: 'max' })
    expect(
      updateOrchestrationWorkerModel(updated.models, withEffort, 'codex', '__agent_default__')
    ).toEqual({ models: { claude: 'opus' }, efforts: { claude: 'high' } })
  })
})
