import { describe, expect, it } from 'vitest'
import { readTaskPageSource } from './task-page-source-family.test-support'

const SOURCE_BAR_SOURCE = readTaskPageSource('task-page/SourceBar.tsx')
const CONTENT_SOURCE = readTaskPageSource('task-page/Content.tsx')
const LIST_CHROME_SOURCE = readTaskPageSource('task-page/ListChrome.tsx')

describe('TaskPage contributed task source boundary', () => {
  it('renders contributed sources as their own group after the built-in options', () => {
    const builtIns = SOURCE_BAR_SOURCE.indexOf('{visibleSourceOptions.map((source) => {')
    const contributed = SOURCE_BAR_SOURCE.indexOf('<TaskPagePluginSourceGroup')

    expect(builtIns).toBeGreaterThanOrEqual(0)
    expect(contributed).toBeGreaterThan(builtIns)
    expect(SOURCE_BAR_SOURCE).toContain('sources={pluginTaskSources}')
    expect(SOURCE_BAR_SOURCE).toContain('selected={selectedPluginTaskSource}')
    expect(SOURCE_BAR_SOURCE).toContain('onSelect={selectPluginTaskSource}')
  })

  it('leaves taskSource closed and shares the plugin-list fetch', () => {
    expect(SOURCE_BAR_SOURCE).toContain('usePluginTaskSourceContributions()')
    expect(SOURCE_BAR_SOURCE).not.toContain('window.api.plugins.list')
    expect(SOURCE_BAR_SOURCE).not.toContain('taskSource: source.sourceId')
  })

  it('clears the contributed selection when a built-in source is picked', () => {
    const builtInClick = SOURCE_BAR_SOURCE.slice(
      SOURCE_BAR_SOURCE.indexOf('taskSourceManuallyChangedRef.current = true'),
      SOURCE_BAR_SOURCE.indexOf('data-task-source={source.id}')
    )

    expect(builtInClick).toContain('selectPluginTaskSource(null)')
  })

  it('renders the contributed list ahead of the taskSource chain', () => {
    const contributed = CONTENT_SOURCE.indexOf('<TaskPagePluginSourceContent')
    const firstBuiltIn = CONTENT_SOURCE.indexOf("taskSource === 'github' && dialogWorkItem")

    expect(contributed).toBeGreaterThanOrEqual(0)
    expect(contributed).toBeLessThan(firstBuiltIn)
    expect(CONTENT_SOURCE).toContain('return selectedPluginTaskSource ? (')
  })

  it('hides built-in mode and filter toolbars while a contributed source is selected', () => {
    expect(LIST_CHROME_SOURCE).toContain('{selectedPluginTaskSource ? null : (')
  })
})
