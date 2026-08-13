import { describe, expect, it } from 'vitest'
import { resolvePaneRendererPolicy } from './terminal-renderer-policy'

describe('resolvePaneRendererPolicy', () => {
  describe('user GPU modes', () => {
    it('keeps the content gate open under `off`', () => {
      const decision = resolvePaneRendererPolicy({ userGpuMode: 'off' })
      // Why: the mode gate downstream forces DOM; the gate stays open so a later
      // switch to auto/on can re-attach without waiting for a new title frame.
      expect(decision).toEqual({
        gpuEnabled: true,
        reason: 'user-setting',
        confidence: 'authoritative'
      })
    })

    it('forces GPU on under `on`', () => {
      const decision = resolvePaneRendererPolicy({ userGpuMode: 'on' })
      expect(decision).toEqual({
        gpuEnabled: true,
        reason: 'user-setting',
        confidence: 'authoritative'
      })
    })

    it('enables GPU under `auto`', () => {
      const decision = resolvePaneRendererPolicy({ userGpuMode: 'auto' })
      expect(decision).toEqual({
        gpuEnabled: true,
        reason: 'capability',
        confidence: 'authoritative'
      })
    })
  })

  describe('WebGL capability and context-loss containment', () => {
    it('disables GPU under `on` when WebGL is unavailable', () => {
      const decision = resolvePaneRendererPolicy({ userGpuMode: 'on', webglUnavailable: true })
      expect(decision).toEqual({
        gpuEnabled: false,
        reason: 'capability',
        confidence: 'authoritative'
      })
    })

    it('disables GPU under `on` inside context-loss containment', () => {
      const decision = resolvePaneRendererPolicy({
        userGpuMode: 'on',
        inContextLossContainment: true
      })
      expect(decision).toEqual({
        gpuEnabled: false,
        reason: 'context-loss',
        confidence: 'authoritative'
      })
    })

    it('disables GPU under `auto` inside context-loss containment', () => {
      const decision = resolvePaneRendererPolicy({
        userGpuMode: 'auto',
        inContextLossContainment: true
      })
      expect(decision.gpuEnabled).toBe(false)
      expect(decision.reason).toBe('context-loss')
    })

    // Why: containment is a live failure signal, so its reason must win over the
    // weaker "no WebGL context" one when both are set.
    it('reports context loss ahead of missing WebGL when both apply', () => {
      const decision = resolvePaneRendererPolicy({
        userGpuMode: 'auto',
        webglUnavailable: true,
        inContextLossContainment: true
      })
      expect(decision).toEqual({
        gpuEnabled: false,
        reason: 'context-loss',
        confidence: 'authoritative'
      })
    })

    it('keeps the content gate open under `off` even without WebGL', () => {
      const decision = resolvePaneRendererPolicy({ userGpuMode: 'off', webglUnavailable: true })
      expect(decision.gpuEnabled).toBe(true)
      expect(decision.reason).toBe('user-setting')
    })
  })
})
