import { describe, expect, it } from 'vitest'
import {
  ON_DEVICE_TEXT_GENERATION_ID,
  ON_DEVICE_TEXT_GENERATION_MODEL_ID,
  formatOnDeviceModelArgument,
  isOnDeviceTextGenerationId,
  macosProductMajorVersion,
  onDeviceTextGenerationSupported,
  parseOnDeviceModelArgument
} from './on-device-text-generation'
import {
  ON_DEVICE_TEXT_GENERATION_CAPABILITY,
  getCommitMessageAgentCapability,
  listCommitMessageAgentCapabilities,
  listTextGenerationAgentIds
} from './source-control/ai/generation/commit-message-agent-spec'

describe('onDeviceTextGenerationSupported', () => {
  it('accepts Apple Silicon on macOS 26 and newer', () => {
    const host = { platform: 'darwin', arch: 'arm64', helperInstalled: true }
    expect(onDeviceTextGenerationSupported({ ...host, osRelease: '26.0' })).toBe(true)
    expect(onDeviceTextGenerationSupported({ ...host, osRelease: '27.2' })).toBe(true)
  })

  it('rejects a capable host whose build shipped no helper', () => {
    expect(
      onDeviceTextGenerationSupported({
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '27.2',
        helperInstalled: false
      })
    ).toBe(false)
  })

  it('rejects Intel Macs, older macOS, and other platforms', () => {
    const installed = { helperInstalled: true }
    expect(
      onDeviceTextGenerationSupported({
        ...installed,
        platform: 'darwin',
        arch: 'x64',
        osRelease: '26.0'
      })
    ).toBe(false)
    expect(
      onDeviceTextGenerationSupported({
        ...installed,
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '15.6'
      })
    ).toBe(false)
    expect(
      onDeviceTextGenerationSupported({
        ...installed,
        platform: 'win32',
        arch: 'arm64',
        osRelease: '26.0'
      })
    ).toBe(false)
    expect(
      onDeviceTextGenerationSupported({
        ...installed,
        platform: 'linux',
        arch: 'arm64',
        osRelease: ''
      })
    ).toBe(false)
  })
})

describe('helper install flag', () => {
  it('travels through the window arguments', () => {
    expect(parseOnDeviceModelArgument([formatOnDeviceModelArgument(true)])).toBe(true)
    expect(parseOnDeviceModelArgument([formatOnDeviceModelArgument(false)])).toBe(false)
    expect(parseOnDeviceModelArgument(['--orca-window-material=blur'])).toBe(false)
  })
})

describe('macosProductMajorVersion', () => {
  it('reads the product major and rejects junk', () => {
    expect(macosProductMajorVersion('26.1')).toBe(26)
    expect(macosProductMajorVersion('27')).toBe(27)
    expect(macosProductMajorVersion('')).toBeNull()
    expect(macosProductMajorVersion('nope')).toBeNull()
  })
})

describe('on-device capability', () => {
  it('identifies its own id but no agent id', () => {
    expect(isOnDeviceTextGenerationId(ON_DEVICE_TEXT_GENERATION_ID)).toBe(true)
    expect(isOnDeviceTextGenerationId('claude')).toBe(false)
    expect(isOnDeviceTextGenerationId(null)).toBe(false)
  })

  it('exposes one static model and resolves by id', () => {
    expect(ON_DEVICE_TEXT_GENERATION_CAPABILITY.modelSource).toBe('static')
    expect(ON_DEVICE_TEXT_GENERATION_CAPABILITY.defaultModelId).toBe(
      ON_DEVICE_TEXT_GENERATION_MODEL_ID
    )
    expect(getCommitMessageAgentCapability(ON_DEVICE_TEXT_GENERATION_ID)).toEqual(
      ON_DEVICE_TEXT_GENERATION_CAPABILITY
    )
  })

  it('stays out of the picker unless the host offers it, but remains a valid stored id', () => {
    const offered = listCommitMessageAgentCapabilities().map((capability) => capability.id)
    expect(offered).not.toContain(ON_DEVICE_TEXT_GENERATION_ID)

    const withProvider = listCommitMessageAgentCapabilities({ onDevice: true }).map(
      (capability) => capability.id
    )
    expect(withProvider).toContain(ON_DEVICE_TEXT_GENERATION_ID)
    expect(listTextGenerationAgentIds()).toContain(ON_DEVICE_TEXT_GENERATION_ID)
  })
})
