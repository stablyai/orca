import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { FEATURE_WALL_WORKFLOWS } from '../../../../shared/feature-wall-workflows'
import { getLocalizedFeatureWallWorkflows } from './feature-wall-workflow-copy'

describe('feature-wall-workflow-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback title/lede matching the raw shared data by default', () => {
    const localized = getLocalizedFeatureWallWorkflows()
    expect(localized.map((workflow) => workflow.id)).toEqual(
      FEATURE_WALL_WORKFLOWS.map((workflow) => workflow.id)
    )
    localized.forEach((workflow, index) => {
      expect(workflow.title).toBe(FEATURE_WALL_WORKFLOWS[index].title)
      expect(workflow.lede).toBe(FEATURE_WALL_WORKFLOWS[index].lede)
    })
  })

  it('leaves non-copy fields untouched', () => {
    const agents = getLocalizedFeatureWallWorkflows().find(
      (workflow) => workflow.id === 'agents-orchestration'
    )
    const rawAgents = FEATURE_WALL_WORKFLOWS.find((w) => w.id === 'agents-orchestration')
    expect(agents?.primaryTileId).toBe(rawAgents?.primaryTileId)
    expect(agents?.relatedTileIds).toEqual(rawAgents?.relatedTileIds)
    expect(agents?.docsUrl).toBe(rawAgents?.docsUrl)
    expect(agents?.meta).toBe(rawAgents?.meta)
  })

  it('does not throw when switching UI language, and keeps the same workflow ids', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(() => getLocalizedFeatureWallWorkflows()).not.toThrow()
    expect(getLocalizedFeatureWallWorkflows().map((workflow) => workflow.id)).toEqual(
      FEATURE_WALL_WORKFLOWS.map((workflow) => workflow.id)
    )
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
