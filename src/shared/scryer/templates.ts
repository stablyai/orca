import type { C4ModelData } from './model-types'

export type BuiltInTemplateId = 'game' | 'saas-platform' | 'website-cms'

export type BuiltInScryerTemplate = {
  id: BuiltInTemplateId
  name: string
  model: C4ModelData
}

export const BUILT_IN_SCRYER_TEMPLATES: BuiltInScryerTemplate[] = [
  {
    id: 'game',
    name: 'Game',
    model: {
      nodes: [
        {
          id: 'node-1',
          type: 'c4',
          position: { x: -80, y: -80 },
          data: { name: 'Player', description: 'Plays the game', kind: 'person' }
        },
        {
          id: 'node-2',
          type: 'c4',
          position: { x: 260, y: -80 },
          data: {
            name: 'Game',
            description: "Single-player game built with Godot's scene tree architecture",
            kind: 'system',
            status: 'proposed'
          }
        },
        {
          id: 'node-10',
          type: 'c4',
          parentId: 'node-2',
          position: { x: 260, y: -80 },
          data: {
            name: 'Game Client',
            description: 'Godot application for gameplay, rendering, UI, and runtime logic',
            kind: 'container',
            technology: 'Godot 4',
            status: 'proposed'
          }
        },
        {
          id: 'node-11',
          type: 'c4',
          parentId: 'node-2',
          position: { x: 260, y: -420 },
          data: {
            name: 'Save Data',
            description: 'Persistent player progress, settings, and world state',
            kind: 'container',
            technology: 'JSON',
            shape: 'cylinder',
            status: 'proposed',
            contract: {
              expect: ['Save files live in user:// directory'],
              ask: [],
              never: ['Store save data in read-only exported resources']
            }
          }
        }
      ],
      edges: [
        {
          id: 'edge-node-1-node-2',
          source: 'node-1',
          target: 'node-2',
          data: { label: 'plays' }
        },
        {
          id: 'edge-node-10-node-11',
          source: 'node-10',
          target: 'node-11',
          data: { label: 'persists' }
        }
      ],
      startingLevel: 'system',
      sourceMap: {},
      refPositions: {},
      groups: [],
      flows: []
    }
  },
  {
    id: 'saas-platform',
    name: 'SaaS Platform',
    model: {
      nodes: [
        {
          id: 'node-1',
          type: 'c4',
          position: { x: 220, y: -80 },
          data: {
            name: 'User',
            description: 'Creates, configures, and monitors hosted workspaces',
            kind: 'person'
          }
        },
        {
          id: 'node-2',
          type: 'c4',
          position: { x: 600, y: -80 },
          data: {
            name: 'SaaS Platform',
            description: 'Multi-tenant platform for user workspaces, billing, and analytics',
            kind: 'system',
            status: 'proposed'
          }
        },
        {
          id: 'node-3',
          type: 'c4',
          position: { x: 980, y: -80 },
          data: {
            name: 'Payment Provider',
            description: 'External subscription billing and payment processing',
            kind: 'system',
            external: true,
            shape: 'hexagon'
          }
        },
        {
          id: 'node-10',
          type: 'c4',
          parentId: 'node-2',
          position: { x: 260, y: -420 },
          data: {
            name: 'Dashboard',
            description: 'Admin interface for workspace management and analytics',
            kind: 'container',
            technology: 'React',
            status: 'proposed'
          }
        },
        {
          id: 'node-11',
          type: 'c4',
          parentId: 'node-2',
          position: { x: 600, y: -420 },
          data: {
            name: 'API Server',
            description: 'HTTP API for workspace data, auth, and billing workflows',
            kind: 'container',
            technology: 'Node.js',
            status: 'proposed'
          }
        },
        {
          id: 'node-12',
          type: 'c4',
          parentId: 'node-2',
          position: { x: 940, y: -420 },
          data: {
            name: 'Database',
            description: 'Stores tenant, workspace, and subscription data',
            kind: 'container',
            technology: 'PostgreSQL',
            shape: 'cylinder',
            status: 'proposed'
          }
        }
      ],
      edges: [
        { id: 'edge-node-1-node-2', source: 'node-1', target: 'node-2', data: { label: 'uses' } },
        {
          id: 'edge-node-11-node-3',
          source: 'node-11',
          target: 'node-3',
          data: { label: 'bills via' }
        },
        {
          id: 'edge-node-11-node-12',
          source: 'node-11',
          target: 'node-12',
          data: { label: 'reads/writes' }
        }
      ],
      startingLevel: 'system',
      sourceMap: {},
      refPositions: {},
      groups: [],
      flows: []
    }
  },
  {
    id: 'website-cms',
    name: 'Website CMS',
    model: {
      nodes: [
        {
          id: 'node-1',
          type: 'c4',
          position: { x: -80, y: -420 },
          data: { name: 'Visitor', description: 'Browses the public website', kind: 'person' }
        },
        {
          id: 'node-2',
          type: 'c4',
          position: { x: -80, y: -80 },
          data: {
            name: 'Admin',
            description: 'Manages CMS content, pages, and lead submissions',
            kind: 'person'
          }
        },
        {
          id: 'node-3',
          type: 'c4',
          position: { x: 260, y: -80 },
          data: {
            name: 'Website',
            description: 'Marketing website with CMS-managed content and lead capture',
            kind: 'system',
            status: 'proposed'
          }
        },
        {
          id: 'node-10',
          type: 'c4',
          parentId: 'node-3',
          position: { x: 100, y: 260 },
          data: {
            name: 'Admin Dashboard',
            description: 'Headless CMS for managing pages, blocks, and leads',
            kind: 'container',
            technology: 'Payload CMS',
            status: 'proposed'
          }
        },
        {
          id: 'node-11',
          type: 'c4',
          parentId: 'node-3',
          position: { x: 420, y: 260 },
          data: {
            name: 'Public Site',
            description: 'Server-rendered website that displays CMS-managed pages',
            kind: 'container',
            technology: 'Next.js',
            status: 'proposed'
          }
        }
      ],
      edges: [
        { id: 'edge-node-1-node-3', source: 'node-1', target: 'node-3', data: { label: 'visits' } },
        { id: 'edge-node-2-node-3', source: 'node-2', target: 'node-3', data: { label: 'edits' } },
        {
          id: 'edge-node-11-node-10',
          source: 'node-11',
          target: 'node-10',
          data: { label: 'loads content' }
        }
      ],
      startingLevel: 'system',
      sourceMap: {},
      refPositions: {},
      groups: [],
      flows: []
    }
  }
]

export function getBuiltInScryerTemplate(id: string): BuiltInScryerTemplate | null {
  return BUILT_IN_SCRYER_TEMPLATES.find((template) => template.id === id) ?? null
}
