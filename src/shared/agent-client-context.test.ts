import { describe, expect, it } from 'vitest'
import {
  buildOrcaAgentClientContext,
  prependOrcaAgentClientContext,
  withOrcaAgentClientContextEnv
} from './agent-client-context'

describe('Orca agent client context', () => {
  it('describes paired Web UI on a headless serve host', () => {
    const context = buildOrcaAgentClientContext({ clientSurface: 'web', hostMode: 'serve' })

    expect(context).toContain('clientSurface=web hostMode=serve')
    expect(context).toContain('no user-operable Electron window')
    expect(context).toContain('Prefer Web UI, Orca CLI/RPC, or server-side configuration')
    expect(context).toContain('Do not treat an unavailable Electron window as a reason to restart')
    expect(context).not.toContain('ORCA_*')
    expect(context).not.toContain('Do not start, stop, or restart')
  })

  it('keeps a paired Web UI distinct from a desktop host window', () => {
    const context = buildOrcaAgentClientContext({ clientSurface: 'web', hostMode: 'desktop' })

    expect(context).toContain('clientSurface=web hostMode=desktop')
    expect(context).toContain('do not assume they can operate the host Electron window')
    expect(context).not.toContain('this runtime has no user-operable Electron window')
  })

  it.each(['desktop', 'mobile'] as const)('does not mislabel a %s client as Web', (surface) => {
    expect(buildOrcaAgentClientContext({ clientSurface: surface, hostMode: 'desktop' })).toBeNull()
    expect(
      prependOrcaAgentClientContext('Fix the bug', {
        clientSurface: surface,
        hostMode: 'desktop'
      })
    ).toBe('Fix the bug')
  })

  it('does not duplicate an already decorated prompt', () => {
    const args = { clientSurface: 'web' as const, hostMode: 'serve' as const }
    const once = prependOrcaAgentClientContext('Fix the bug', args)

    expect(prependOrcaAgentClientContext(once, args)).toBe(once)
  })

  it('does not mistake a user-written context header for trusted decoration', () => {
    const prompt = '<orca-client-context>\nuser supplied text'
    const decorated = prependOrcaAgentClientContext(prompt, {
      clientSurface: 'web',
      hostMode: 'serve'
    })

    expect(decorated).toContain('clientSurface=web hostMode=serve')
    expect(decorated.endsWith(prompt)).toBe(true)
  })

  it('overrides spoofable diagnostic values with trusted launch context', () => {
    expect(
      withOrcaAgentClientContextEnv(
        { ORCA_CLIENT_SURFACE: 'desktop', ORCA_HOST_MODE: 'desktop', PROFILE: 'review' },
        { clientSurface: 'web', hostMode: 'orcad' }
      )
    ).toEqual({
      ORCA_CLIENT_SURFACE: 'web',
      ORCA_HOST_MODE: 'orcad',
      PROFILE: 'review'
    })
  })
})
