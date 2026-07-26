import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory,
  SkillFreshnessStatus
} from '../../../shared/skill-freshness'
import type { DiscoveredSkill } from '../../../shared/skills'
import {
  getAgentSkillNavInstallStatus,
  getLinearAgentSkillNavInstallStatus
} from './agent-skill-nav-install-status'

function skill(name: string): DiscoveredSkill {
  const directoryPath = path.join('home', 'test', '.agents', 'skills', name)
  return {
    id: name,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: path.dirname(directoryPath),
    directoryPath,
    skillFilePath: path.join(directoryPath, 'SKILL.md'),
    installed: true,
    fileCount: 1,
    updatedAt: null
  }
}

function placement(name: string, status: SkillFreshnessStatus): SkillFreshnessInstallation {
  const unresolvedPath = path.join('home', 'test', '.agents', 'skills', name)
  return {
    id: name,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath,
    resolvedPath: unresolvedPath,
    physicalIdentity: name,
    topology: 'canonical-copy',
    status,
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: status === 'current' ? 'current' : 'other',
    errorCategory: null
  }
}

function inventory(
  installations: SkillFreshnessInstallation[],
  eligibleUpdateNames: string[] = []
): SkillFreshnessInventory {
  return { schemaVersion: 1, installations, eligibleUpdateNames, scannedAt: 1 }
}

describe('getAgentSkillNavInstallStatus', () => {
  it('keeps loading and missing states ahead of freshness', () => {
    expect(
      getAgentSkillNavInstallStatus({
        name: 'orca-linear',
        installed: true,
        loading: true,
        inventory: inventory([placement('orca-linear', 'current')])
      })
    ).toBe('checking')
    expect(
      getAgentSkillNavInstallStatus({
        name: 'orca-linear',
        installed: false,
        loading: false,
        inventory: null
      })
    ).toBe('install')
  })
})

describe('getLinearAgentSkillNavInstallStatus', () => {
  it('reports canonical installs under orca-linear', () => {
    const skills = [skill('orca-linear')]

    expect(
      getLinearAgentSkillNavInstallStatus({
        skills,
        installed: true,
        loading: false,
        inventory: inventory([placement('orca-linear', 'current')])
      })
    ).toBe('up-to-date')
    expect(
      getLinearAgentSkillNavInstallStatus({
        skills,
        installed: true,
        loading: false,
        inventory: inventory([placement('orca-linear', 'outdated')], ['orca-linear'])
      })
    ).toBe('update-available')
  })

  it('reports legacy-only installs under linear-tickets', () => {
    expect(
      getLinearAgentSkillNavInstallStatus({
        skills: [skill('linear-tickets')],
        installed: true,
        loading: false,
        inventory: inventory([placement('linear-tickets', 'current')])
      })
    ).toBe('up-to-date')
  })

  it('prefers canonical freshness when both names are installed', () => {
    expect(
      getLinearAgentSkillNavInstallStatus({
        skills: [skill('orca-linear'), skill('linear-tickets')],
        installed: true,
        loading: false,
        inventory: inventory(
          [placement('orca-linear', 'current'), placement('linear-tickets', 'outdated')],
          ['linear-tickets']
        )
      })
    ).toBe('up-to-date')
  })

  it('falls back to presence-only status when freshness does not apply', () => {
    expect(
      getLinearAgentSkillNavInstallStatus({
        skills: [skill('orca-linear')],
        installed: true,
        loading: false,
        inventory: null
      })
    ).toBe('installed')
  })
})
