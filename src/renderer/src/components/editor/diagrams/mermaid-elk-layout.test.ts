import { describe, expect, it } from 'vitest'
import { sourceUsesElkLayout } from './mermaid-elk-layout'

describe('sourceUsesElkLayout', () => {
  it('detects the frontmatter config form', () => {
    expect(
      sourceUsesElkLayout(`---
config:
  layout: elk
---
flowchart TD
  A --> B`)
    ).toBe(true)
  })

  it('detects quoted values, comments and elk sub-layouts', () => {
    expect(
      sourceUsesElkLayout(`---
config:
  layout: 'elk.stress'
---
flowchart TD
  A --> B`)
    ).toBe(true)
    expect(
      sourceUsesElkLayout(`---
config:
  layout: elk # use the layered engine
---
flowchart TD
  A --> B`)
    ).toBe(true)
    expect(
      sourceUsesElkLayout(`---
config: {layout: elk}
---
flowchart TD
  A --> B`)
    ).toBe(true)
  })

  it('detects the init directive and flowchart-elk syntax in the diagram body', () => {
    expect(sourceUsesElkLayout('%%{init: {"layout": "elk"}}%%\nflowchart TD\n A --> B')).toBe(true)
    expect(sourceUsesElkLayout('flowchart-elk TD\n  A --> B')).toBe(true)
  })

  it('ignores top-level layout, non-elk values and frontmatter text', () => {
    expect(sourceUsesElkLayout('flowchart TD\n  A[layout: elk] --> B')).toBe(false)
    expect(
      sourceUsesElkLayout(`---
layout: elk # Mermaid ignores top-level layout
---
flowchart TD
  A --> B`)
    ).toBe(false)
    expect(sourceUsesElkLayout('%%{init: {"layout": "elkjs"}}%%\nflowchart TD\n A --> B')).toBe(
      false
    )
    expect(
      sourceUsesElkLayout(`---
title: |
  flowchart-elk TD
---
flowchart TD
  A --> B`)
    ).toBe(false)
    expect(
      sourceUsesElkLayout(`---
config:
  layout: dagre
---
flowchart TD
  A --> B`)
    ).toBe(false)
  })
})
