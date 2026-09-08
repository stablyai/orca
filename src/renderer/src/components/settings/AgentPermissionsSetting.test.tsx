import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentPermissionModeControl } from './AgentPermissionsSetting'

describe('agent permission choices', () => {
  it('offers Auto only to supported agents', () => {
    const supported = renderToStaticMarkup(
      <AgentPermissionModeControl agent="claude" mode="auto" onChange={vi.fn()} />
    )
    const unsupported = renderToStaticMarkup(
      <AgentPermissionModeControl agent="aider" mode="manual" onChange={vi.fn()} />
    )
    expect(supported).toContain('>Auto</button>')
    expect(unsupported).not.toContain('>Auto</button>')
    expect(unsupported).toContain('>Manual</button>')
    expect(unsupported).toContain('>Yolo</button>')
  })

  it('disables presets while custom launch settings need editing', () => {
    const html = renderToStaticMarkup(
      <AgentPermissionModeControl agent="claude" mode="mixed" onChange={vi.fn()} />
    )
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3)
    expect(html).not.toContain('aria-checked="true"')
  })

  it('passes an explicitly selected global preset through', () => {
    const onChange = vi.fn()
    const element = AgentPermissionModeControl({ mode: 'mixed', onChange })
    element.props.onChange('auto')
    expect(onChange).toHaveBeenCalledWith('auto')
    expect(element.props.options.every((option: { disabled: boolean }) => !option.disabled)).toBe(
      true
    )
  })
})
