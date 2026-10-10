import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { DEVIN_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-devin'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { DEVIN_MODEL_LIST_ARGS, parseDevinModelList } from './devin-model-list-probe'

// Row shape as `devin models list --format json` prints it (devin 3000.11.3):
// families group variants, and a variant's model_uid is the id `--model` takes.
const LISTING = JSON.stringify({
  families: [
    {
      family_label: 'Adaptive',
      family_uid: 'Adaptive',
      slug: 'adaptive',
      aliases: [],
      variants: [
        {
          model_uid: 'adaptive',
          label: 'Adaptive',
          description: 'Automatically balances quality and cost',
          is_new: false,
          is_beta: false
        }
      ]
    },
    {
      family_label: 'SWE-2',
      family_uid: 'swe-2',
      slug: 'swe-2',
      aliases: ['swe'],
      variants: [
        {
          model_uid: 'swe-2-high',
          label: 'SWE-2 High',
          max_context_tokens: 262000,
          cost_tier: 'Free'
        },
        {
          model_uid: 'swe-2-medium',
          label: 'SWE-2 Medium',
          max_context_tokens: 262000,
          cost_tier: 'Free'
        },
        // A repeat uid is one model, not two rows.
        { model_uid: 'swe-2-medium', label: 'SWE-2 Medium' },
        // Rows that cannot be launched are dropped rather than guessed.
        { label: 'No uid' },
        'not a row'
      ]
    }
  ]
})

describe('devin model list probe', () => {
  it('asks devin for its machine-readable listing', () => {
    expect(DEVIN_MODEL_LIST_ARGS).toEqual(['models', 'list', '--format', 'json'])
  })

  it('parses variant uids as ids and labels, with family as the fallback description', () => {
    expect(parseDevinModelList(LISTING)).toEqual([
      {
        id: 'adaptive',
        label: 'Adaptive',
        description: 'Automatically balances quality and cost'
      },
      {
        id: 'swe-2-high',
        label: 'SWE-2 High',
        description: 'SWE-2',
        contextWindowTokens: 262000
      },
      {
        id: 'swe-2-medium',
        label: 'SWE-2 Medium',
        description: 'SWE-2',
        contextWindowTokens: 262000
      }
    ])
  })

  it('tolerates an update notice printed ahead of the JSON', () => {
    expect(parseDevinModelList(`Update available\n${LISTING}\n`).map(({ id }) => id)).toEqual([
      'adaptive',
      'swe-2-high',
      'swe-2-medium'
    ])
  })

  it('returns nothing for output that is not a listing', () => {
    expect(parseDevinModelList('')).toEqual([])
    expect(parseDevinModelList('devin: command not found')).toEqual([])
    expect(parseDevinModelList('{"families": "nope"}')).toEqual([])
    expect(parseDevinModelList('[1, 2]')).toEqual([])
    expect(parseDevinModelList(JSON.stringify({ families: [{ variants: 'nope' }] }))).toEqual([])
  })
})

describe('devin session option catalog', () => {
  it('is registered for the devin agent', () => {
    expect(getAgentSessionOptionCatalog('devin')).toBe(DEVIN_SESSION_OPTION_CATALOG)
  })

  it('seeds no model because the account lists them', () => {
    expect(DEVIN_SESSION_OPTION_CATALOG.models).toEqual([])
    expect(DEVIN_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBe(true)
    // Effort lives inside the model id (swe-2-medium), so no option is offered.
    expect(DEVIN_SESSION_OPTION_CATALOG.unknownModelOptions).toBeUndefined()
  })

  it('discovers models through the same JSON listing the probe parses', () => {
    const listModels = DEVIN_SESSION_OPTION_CATALOG.listModels!
    expect(listModels.command).toBe('devin models list --format json')
    expect(listModels.parse(LISTING)).toEqual([
      {
        id: 'adaptive',
        label: 'Adaptive',
        description: 'Automatically balances quality and cost',
        options: []
      },
      {
        id: 'swe-2-high',
        label: 'SWE-2 High',
        description: 'SWE-2',
        contextWindowTokens: 262000,
        options: []
      },
      {
        id: 'swe-2-medium',
        label: 'SWE-2 Medium',
        description: 'SWE-2',
        contextWindowTokens: 262000,
        options: []
      }
    ])
  })

  it('launches a picked model with --model <id>', () => {
    expect(resolveAgentSessionOptionLaunch('devin', { model: 'swe-2-medium' })).toEqual({
      args: ['--model', 'swe-2-medium'],
      appliedValues: { model: 'swe-2-medium' }
    })
    expect(resolveAgentSessionOptionLaunch('devin', {})).toEqual({ args: [], appliedValues: {} })
  })

  it('yields to a user --model in the launch args, in either spelling', () => {
    const remove = DEVIN_SESSION_OPTION_CATALOG.modelApply.removeAgentArgs!
    expect(
      remove([
        '--permission-mode',
        'bypass',
        '--model',
        'swe-2-max',
        '--model=swe-2-high',
        '--respect-workspace-trust',
        'false'
      ])
    ).toEqual(['--permission-mode', 'bypass', '--respect-workspace-trust', 'false'])
  })
})
